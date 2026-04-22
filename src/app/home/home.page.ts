import {
  Component, OnInit, AfterViewInit, OnDestroy,
  ViewChild, ElementRef, HostListener
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonContent, IonHeader, IonToolbar, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  pencilOutline, squareOutline, ellipseOutline, removeOutline,
  colorFillOutline, trashOutline, sendOutline,
  arrowUndoOutline, arrowRedoOutline, bluetoothOutline, bluetooth,
  removeCircleOutline, refreshOutline, closeCircleOutline,
  expandOutline, optionsOutline
} from 'ionicons/icons';
import { BluetoothService, BtDevice, FirmwareEvent } from '../services/bluetooth.service';
import { Subscription } from 'rxjs';

// Dimensiones del frame que espera el firmware (fijo). Al enviar se reescala
// desde el tamano actual de edicion a esta resolucion.
const PROTO_ROWS = 24;
const PROTO_COLS = 96;
const MAX_HISTORY = 20;
const BLACK = '#000000';
// Color unico del lapiz. La matriz MAX7219 es monocroma (LEDs rojos), asi
// que en la app trabajamos en rojo/negro y al enviar binarizamos.
const ON_COLOR = '#ff0000';

type ToolId = 'pencil' | 'eraser' | 'rect' | 'circle' | 'line' | 'fill';

interface ShapeDef {
  id: string;
  name: string;
  color: string;
  pattern: string[];
  previewUrl?: string;
}

interface MatrixPreset {
  id: string;
  label: string;
  rows: number;
  cols: number;
}

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [IonHeader, IonToolbar, IonContent, IonIcon, CommonModule, FormsModule],
})
export class HomePage implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('ledCanvas', { static: false }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('canvasScroll', { static: false }) scrollRef?: ElementRef<HTMLDivElement>;

  grid: string[][] = [];
  isDrawing = false;
  activeTool: ToolId = 'pencil';
  readonly currentColor = ON_COLOR;
  cellSize = 8;
  showGrid = true;
  startCell = { row: 0, col: 0 };
  cursorPos = { row: 0, col: 0 };
  history: string[][][] = [];
  historyIndex = -1;

  // Tamano actual del lienzo. Presets basados en multiplos del modulo fisico
  // (32x8). El envio siempre reescala a 96x24 (lo que espera el firmware).
  matrixRows = 8;
  matrixCols = 32;
  matrixPresets: MatrixPreset[] = [
    { id: 'x1', label: 'x1  (32 x 8)',  rows: 8,  cols: 32 },
    { id: 'x2', label: 'x2  (64 x 16)', rows: 16, cols: 64 },
    { id: 'x3', label: 'x3  (96 x 24)', rows: 24, cols: 96 },
  ];
  currentPresetId: string = 'x1';

  arduinoConnected = false;
  portName = '';
  baudRate = '115200';
  sending = false;
  sendProgress = 0;
  /** Panel derecho abierto como drawer en movil. */
  mobilePanelOpen = false;
  private ctx!: CanvasRenderingContext2D;

  // Bluetooth UI state
  btMode: 'bluetooth' | 'serial' | 'none' = 'none';
  showDevicePicker = false;
  btDevices: BtDevice[] = [];
  btScanning = false;
  btError = '';
  preferredDevice: BtDevice | null = null;
  /** Handshake con el firmware: true tras recibir READY al menos una vez */
  firmwareReady = false;
  /** Ultima linea de estado recibida del firmware (para UI/debug) */
  firmwareStatus = '';
  /** Estado visible del boton/chip, derivado del resto de flags. */
  btPhase: 'idle' | 'connecting' | 'awaiting-fw' | 'ready' | 'sending' | 'frame-ok' | 'error' = 'idle';
  private btStatusSub?: Subscription;
  private btNameSub?: Subscription;
  private fwSub?: Subscription;
  private phaseResetTimer?: any;

  constructor(private bt: BluetoothService) {}

  tools: { id: ToolId; icon: string; label: string; key: string }[] = [
    { id: 'pencil', icon: 'pencil-outline',        label: 'Lápiz',      key: 'P' },
    { id: 'eraser', icon: 'remove-circle-outline', label: 'Borrador',   key: 'E' },
    { id: 'rect',   icon: 'square-outline',        label: 'Rectángulo', key: 'R' },
    { id: 'circle', icon: 'ellipse-outline',       label: 'Círculo',    key: 'C' },
    { id: 'line',   icon: 'remove-outline',        label: 'Línea',      key: 'L' },
    { id: 'fill',   icon: 'color-fill-outline',    label: 'Relleno',    key: 'F' },
  ];

  // Formas simples, pensadas para caber en la matriz mas pequena (32 x 8).
  // Todas son <= 8 filas y <= 8 columnas, asi entran en cualquier preset.
  referenceShapes: ShapeDef[] = [
    {
      id: 'heart', name: 'Corazón', color: ON_COLOR,
      pattern: [
        '.XX.XX.',
        'XXXXXXX',
        'XXXXXXX',
        '.XXXXX.',
        '..XXX..',
        '...X...',
      ]
    },
    {
      id: 'star', name: 'Estrella', color: ON_COLOR,
      pattern: [
        '...X...',
        '...X...',
        'XXXXXXX',
        '.XXXXX.',
        '..X.X..',
        '.X...X.',
      ]
    },
    {
      id: 'arrow-r', name: 'Flecha →', color: ON_COLOR,
      pattern: [
        '...X....',
        '....X...',
        'XXXXXXXX',
        '....X...',
        '...X....',
      ]
    },
    {
      id: 'arrow-l', name: 'Flecha ←', color: ON_COLOR,
      pattern: [
        '....X...',
        '...X....',
        'XXXXXXXX',
        '...X....',
        '....X...',
      ]
    },
    {
      id: 'smiley', name: 'Carita :)', color: ON_COLOR,
      pattern: [
        '.XXXX.',
        'X....X',
        'X.XX.X',
        'X....X',
        'XX..XX',
        '.XXXX.',
      ]
    },
    {
      id: 'circle', name: 'Círculo', color: ON_COLOR,
      pattern: [
        '.XXXX.',
        'XXXXXX',
        'XXXXXX',
        'XXXXXX',
        'XXXXXX',
        '.XXXX.',
      ]
    },
    {
      id: 'square', name: 'Cuadrado', color: ON_COLOR,
      pattern: [
        'XXXXXX',
        'X....X',
        'X....X',
        'X....X',
        'X....X',
        'XXXXXX',
      ]
    },
    {
      id: 'diamond', name: 'Diamante', color: ON_COLOR,
      pattern: [
        '...X...',
        '..XXX..',
        '.XXXXX.',
        'XXXXXXX',
        '.XXXXX.',
        '..XXX..',
        '...X...',
      ]
    },
    {
      id: 'cross', name: 'Cruz X', color: ON_COLOR,
      pattern: [
        'X...X',
        '.X.X.',
        '..X..',
        '.X.X.',
        'X...X',
      ]
    },
    {
      id: 'lightning', name: 'Rayo', color: ON_COLOR,
      pattern: [
        '...XX',
        '..XX.',
        '.XXXX',
        'XX...',
        '.XX..',
        '.X...',
      ]
    },
  ];

  ngOnInit() {
    addIcons({
      pencilOutline, squareOutline, ellipseOutline, removeOutline,
      colorFillOutline, trashOutline, sendOutline,
      arrowUndoOutline, arrowRedoOutline, bluetoothOutline, bluetooth,
      removeCircleOutline, refreshOutline, closeCircleOutline,
      expandOutline, optionsOutline,
    });
    this.initGrid();
    this.saveHistory();

    this.btMode = this.bt.getMode();
    this.btStatusSub = this.bt.status$.subscribe((s) => {
      this.arduinoConnected = s === 'connected';
      if (s === 'connecting') {
        this.btPhase = 'connecting';
      } else if (s === 'connected') {
        this.btPhase = this.firmwareReady ? 'ready' : 'awaiting-fw';
      } else {
        this.btPhase = this.btError ? 'error' : 'idle';
        this.firmwareReady = false;
        this.firmwareStatus = '';
      }
    });
    this.btNameSub = this.bt.deviceName$.subscribe((n) => {
      this.portName = n;
    });
    // Feedback real del Arduino (READY/ACK/NAK). Sin esto la app no tenia
    // forma de saber si la comunicacion funcionaba.
    this.fwSub = this.bt.firmware$.subscribe((ev: FirmwareEvent) => {
      this.onFirmwareEvent(ev);
    });

    // Solicitar permisos al arrancar y precargar el HC-05 emparejado si existe.
    // Pequeño retardo para dar tiempo a Cordova/deviceready a inyectar
    // window.bluetoothSerial en la webview.
    setTimeout(() => this.autoInitBluetooth(), 400);
  }

  private async autoInitBluetooth() {
    this.btMode = this.bt.refreshMode();
    if (this.btMode !== 'bluetooth') return;
    try {
      await this.bt.requestPermissions();
      const devices = await this.bt.listPaired();
      this.btDevices = devices;
      this.preferredDevice = this.bt.pickPreferred(devices);
      if (this.preferredDevice) {
        this.portName = this.preferredDevice.name;
      }
    } catch (e: any) {
      console.warn('[BT] auto-init:', e?.message);
      this.btError = e?.message || '';
    }
  }

  ngAfterViewInit() {
    const canvas = this.canvasRef.nativeElement;
    this.ctx = canvas.getContext('2d')!;
    // Espera un tick para que el contenedor tenga dimensiones medibles.
    setTimeout(() => this.fitCanvasToContainer(), 0);
    setTimeout(() => {
      this.referenceShapes.forEach(s => { s.previewUrl = this.generateShapePreview(s); });
    }, 50);
  }

  @HostListener('window:resize')
  onWindowResize() {
    this.fitCanvasToContainer();
  }

  ngOnDestroy() {
    this.btStatusSub?.unsubscribe();
    this.btNameSub?.unsubscribe();
    this.fwSub?.unsubscribe();
  }

  private onFirmwareEvent(ev: FirmwareEvent) {
    switch (ev.kind) {
      case 'ready':
        this.firmwareReady = true;
        this.firmwareStatus = 'Arduino listo';
        this.btError = '';
        if (this.arduinoConnected) this.setPhase('ready');
        break;
      case 'ack':
        this.firmwareStatus = 'Frame enviado correctamente';
        this.setPhase('frame-ok');
        // Volver a "ready" tras 2s para no quedarnos en el estado de exito.
        clearTimeout(this.phaseResetTimer);
        this.phaseResetTimer = setTimeout(() => {
          if (this.arduinoConnected && this.firmwareReady) this.setPhase('ready');
        }, 2000);
        break;
      case 'nak':
        this.firmwareStatus = 'NAK del firmware: ' + ev.reason;
        this.btError = 'El Arduino rechazo la trama (' + ev.reason + '). Reintenta el envio.';
        this.setPhase('error');
        break;
      case 'other':
        // Ignorado para UI, pero util en logs.
        console.log('[FW]', ev.line);
        break;
    }
  }

  private setPhase(p: HomePage['btPhase']) {
    this.btPhase = p;
  }

  // Textos y colores derivados del btPhase (getter para el template).
  get phaseLabel(): string {
    switch (this.btPhase) {
      case 'connecting':   return 'Conectando...';
      case 'awaiting-fw':  return 'Esperando Arduino...';
      case 'ready':        return 'Listo';
      case 'sending':      return 'Enviando trama...';
      case 'frame-ok':     return 'Trama enviada';
      case 'error':        return 'Error';
      default:             return 'Sin conexion';
    }
  }

  get phaseBusy(): boolean {
    return this.btPhase === 'connecting' || this.btPhase === 'awaiting-fw' || this.btPhase === 'sending';
  }

  // ─── GRID ────────────────────────────────────────────────────────────────

  initGrid() {
    this.grid = Array.from({ length: this.matrixRows }, () => Array(this.matrixCols).fill(BLACK));
  }

  resizeCanvas() {
    const canvas = this.canvasRef.nativeElement;
    const g = this.showGrid ? 1 : 0;
    canvas.width  = this.matrixCols * (this.cellSize + g) + g;
    canvas.height = this.matrixRows * (this.cellSize + g) + g;
  }

  /** Cambia el tamano del lienzo conservando el dibujo CENTRADO. */
  setMatrixPreset(presetId: string) {
    const p = this.matrixPresets.find((x) => x.id === presetId);
    if (!p || (p.rows === this.matrixRows && p.cols === this.matrixCols)) return;
    const prev = this.grid;
    const prevRows = prev.length;
    const prevCols = prev[0]?.length || 0;
    // Offset para centrar el contenido anterior en el nuevo lienzo
    // (negativo = recorte desde el centro al reducir).
    const offR = Math.floor((p.rows - prevRows) / 2);
    const offC = Math.floor((p.cols - prevCols) / 2);
    const next: string[][] = Array.from({ length: p.rows }, (_, r) =>
      Array.from({ length: p.cols }, (_, c) => {
        const sr = r - offR, sc = c - offC;
        return (sr >= 0 && sr < prevRows && sc >= 0 && sc < prevCols)
          ? prev[sr][sc] : BLACK;
      })
    );
    this.matrixRows = p.rows;
    this.matrixCols = p.cols;
    this.currentPresetId = p.id;
    this.grid = next;
    // El historial previo tenia dimensiones distintas; lo reiniciamos.
    this.history = [];
    this.historyIndex = -1;
    this.saveHistory();
    this.fitCanvasToContainer();
  }

  /** Ajusta cellSize para que el lienzo completo quepa en el area visible. */
  fitCanvasToContainer() {
    const scrollEl = this.scrollRef?.nativeElement;
    if (!scrollEl || !this.canvasRef?.nativeElement) {
      this.resizeCanvas();
      this.render();
      return;
    }
    // Restamos el padding del contenedor (24px por lado en desktop, 8 en movil).
    const style = window.getComputedStyle(scrollEl);
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const availW = Math.max(60, scrollEl.clientWidth - padX);
    const availH = Math.max(60, scrollEl.clientHeight - padY);
    const g = this.showGrid ? 1 : 0;
    const byW = Math.floor((availW - g) / this.matrixCols) - g;
    const byH = Math.floor((availH - g) / this.matrixRows) - g;
    const size = Math.max(2, Math.min(32, Math.min(byW, byH)));
    this.cellSize = size;
    this.resizeCanvas();
    this.render();
  }

  onCellSizeChange() { this.resizeCanvas(); this.render(); }

  // ─── RENDER ──────────────────────────────────────────────────────────────

  renderGrid(grid: string[][] = this.grid) {
    if (!this.ctx) return;
    const canvas = this.canvasRef.nativeElement;
    const g = this.showGrid ? 1 : 0;
    const step = this.cellSize + g;

    this.ctx.fillStyle = '#1a1a2e';
    this.ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let r = 0; r < this.matrixRows; r++) {
      for (let c = 0; c < this.matrixCols; c++) {
        const color = grid[r][c];
        this.ctx.fillStyle = color === BLACK ? '#0d0d1a' : color;
        this.ctx.fillRect(g + c * step, g + r * step, this.cellSize, this.cellSize);
      }
    }
  }

  render() { this.renderGrid(this.grid); }

  // ─── MOUSE EVENTS ────────────────────────────────────────────────────────

  onMouseDown(e: MouseEvent) {
    e.preventDefault();
    const cell = this.getCellFromEvent(e);
    if (!cell) return;

    if (this.activeTool === 'fill') {
      this.saveHistory();
      this.floodFill(cell.row, cell.col, this.currentColor);
      this.render();
      return;
    }

    this.isDrawing = true;
    this.startCell = { ...cell };

    if (this.activeTool === 'pencil') {
      this.saveHistory();
      this.grid[cell.row][cell.col] = this.currentColor;
      this.render();
    } else if (this.activeTool === 'eraser') {
      this.saveHistory();
      this.grid[cell.row][cell.col] = BLACK;
      this.render();
    }
  }

  onMouseMove(e: MouseEvent) {
    const cell = this.getCellFromEvent(e);
    if (cell) this.cursorPos = cell;
    if (!this.isDrawing || !cell) return;

    if (this.activeTool === 'pencil') {
      this.grid[cell.row][cell.col] = this.currentColor;
      this.render();
    } else if (this.activeTool === 'eraser') {
      this.grid[cell.row][cell.col] = BLACK;
      this.render();
    } else if (['rect', 'circle', 'line'].includes(this.activeTool)) {
      this.renderPreview(cell.row, cell.col);
    }
  }

  onMouseUp(e: MouseEvent) {
    if (!this.isDrawing) return;
    const cell = this.getCellFromEvent(e) ?? this.cursorPos;
    if (['rect', 'circle', 'line'].includes(this.activeTool)) {
      this.saveHistory();
      if (this.activeTool === 'rect')
        this.drawRectOnGrid(this.grid, this.startCell.row, this.startCell.col, cell.row, cell.col, this.currentColor);
      else if (this.activeTool === 'circle')
        this.drawCircleOnGrid(this.grid, this.startCell.row, this.startCell.col, cell.row, cell.col, this.currentColor);
      else if (this.activeTool === 'line')
        this.drawLineOnGrid(this.grid, this.startCell.row, this.startCell.col, cell.row, cell.col, this.currentColor);
      this.render();
    }
    this.isDrawing = false;
  }

  onMouseLeave() {
    if (this.isDrawing) { this.isDrawing = false; this.render(); }
    this.cursorPos = { row: 0, col: 0 };
  }

  onTouchStart(e: TouchEvent) {
    e.preventDefault();
    const t = e.touches[0];
    this.onMouseDown({ clientX: t.clientX, clientY: t.clientY, preventDefault: () => {} } as MouseEvent);
  }
  onTouchMove(e: TouchEvent) {
    e.preventDefault();
    const t = e.touches[0];
    this.onMouseMove({ clientX: t.clientX, clientY: t.clientY } as MouseEvent);
  }
  onTouchEnd(e: TouchEvent) {
    e.preventDefault();
    const t = e.changedTouches[0];
    this.onMouseUp({ clientX: t.clientX, clientY: t.clientY } as MouseEvent);
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
      if (e.key === 'y') { e.preventDefault(); this.redo(); }
    } else {
      const map: Record<string, ToolId> = {
        p: 'pencil', e: 'eraser', r: 'rect',
        c: 'circle', l: 'line',   f: 'fill'
      };
      const tool = map[e.key.toLowerCase()];
      if (tool) this.activeTool = tool;
    }
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────

  getCellFromEvent(e: { clientX: number; clientY: number }): { row: number; col: number } | null {
    const canvas = this.canvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const g = this.showGrid ? 1 : 0;
    const step = this.cellSize + g;
    const col = Math.floor(((e.clientX - rect.left) * scaleX) / step);
    const row = Math.floor(((e.clientY - rect.top)  * scaleY) / step);
    if (col < 0 || col >= this.matrixCols || row < 0 || row >= this.matrixRows) return null;
    return { row, col };
  }

  paintCell(grid: string[][], row: number, col: number, color: string) {
    if (row >= 0 && row < this.matrixRows && col >= 0 && col < this.matrixCols) grid[row][col] = color;
  }

  renderPreview(endRow: number, endCol: number) {
    const preview = this.grid.map(r => [...r]);
    if (this.activeTool === 'rect')
      this.drawRectOnGrid(preview, this.startCell.row, this.startCell.col, endRow, endCol, this.currentColor);
    else if (this.activeTool === 'circle')
      this.drawCircleOnGrid(preview, this.startCell.row, this.startCell.col, endRow, endCol, this.currentColor);
    else if (this.activeTool === 'line')
      this.drawLineOnGrid(preview, this.startCell.row, this.startCell.col, endRow, endCol, this.currentColor);
    this.renderGrid(preview);
  }

  // ─── PRIMITIVAS DE DIBUJO ─────────────────────────────────────────────────

  drawRectOnGrid(grid: string[][], r1: number, c1: number, r2: number, c2: number, color: string) {
    const rMin = Math.min(r1, r2), rMax = Math.max(r1, r2);
    const cMin = Math.min(c1, c2), cMax = Math.max(c1, c2);
    for (let r = rMin; r <= rMax; r++) {
      for (let c = cMin; c <= cMax; c++) {
        if (r === rMin || r === rMax || c === cMin || c === cMax)
          this.paintCell(grid, r, c, color);
      }
    }
  }

  drawCircleOnGrid(grid: string[][], r1: number, c1: number, r2: number, c2: number, color: string) {
    const cr = (r1 + r2) / 2, cc = (c1 + c2) / 2;
    const ry = Math.abs(r2 - r1) / 2, rx = Math.abs(c2 - c1) / 2;
    if (rx < 1 && ry < 1) { this.paintCell(grid, r1, c1, color); return; }
    const steps = Math.max(Math.ceil(2 * Math.PI * Math.max(rx, ry) * 2), 60);
    for (let i = 0; i < steps; i++) {
      const angle = (2 * Math.PI * i) / steps;
      this.paintCell(grid, Math.round(cr + ry * Math.sin(angle)), Math.round(cc + rx * Math.cos(angle)), color);
    }
  }

  drawLineOnGrid(grid: string[][], r1: number, c1: number, r2: number, c2: number, color: string) {
    let r = r1, c = c1;
    const dr = Math.abs(r2 - r1), dc = Math.abs(c2 - c1);
    const sr = r1 < r2 ? 1 : -1, sc = c1 < c2 ? 1 : -1;
    let err = dc - dr;
    for (;;) {
      this.paintCell(grid, r, c, color);
      if (r === r2 && c === c2) break;
      const e2 = 2 * err;
      if (e2 > -dr) { err -= dr; c += sc; }
      if (e2 < dc)  { err += dc; r += sr; }
    }
  }

  floodFill(startRow: number, startCol: number, newColor: string) {
    const oldColor = this.grid[startRow][startCol];
    if (oldColor === newColor) return;
    const stack: [number, number][] = [[startRow, startCol]];
    while (stack.length) {
      const [r, c] = stack.pop()!;
      if (r < 0 || r >= this.matrixRows || c < 0 || c >= this.matrixCols || this.grid[r][c] !== oldColor) continue;
      this.grid[r][c] = newColor;
      stack.push([r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]);
    }
  }

  // ─── FIGURAS ─────────────────────────────────────────────────────────────

  applyShape(shape: ShapeDef) {
    this.saveHistory();
    const h = shape.pattern.length;
    const w = Math.max(...shape.pattern.map(row => row.length));
    const startR = Math.max(0, Math.floor((this.matrixRows - h) / 2));
    const startC = Math.max(0, Math.floor((this.matrixCols - w) / 2));
    // Usamos el color activo del lapiz para respetar la eleccion del usuario.
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < shape.pattern[r].length; c++) {
        if (shape.pattern[r][c] === 'X')
          this.paintCell(this.grid, startR + r, startC + c, this.currentColor);
      }
    }
    this.render();
  }

  generateShapePreview(shape: ShapeDef): string {
    const h = shape.pattern.length;
    const w = Math.max(...shape.pattern.map(row => row.length));
    const cs = Math.max(2, Math.min(5, Math.floor(44 / Math.max(h, w))));
    const canvas = document.createElement('canvas');
    canvas.width = w * cs; canvas.height = h * cs;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#0d0d1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < shape.pattern[r].length; c++) {
        if (shape.pattern[r][c] === 'X') {
          ctx.fillStyle = shape.color;
          ctx.fillRect(c * cs, r * cs, cs, cs);
        }
      }
    }
    return canvas.toDataURL();
  }

  // ─── HISTORIAL ───────────────────────────────────────────────────────────

  saveHistory() {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(this.grid.map(r => [...r]));
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.historyIndex = this.history.length - 1;
  }

  undo() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.grid = this.history[this.historyIndex].map(r => [...r]);
      this.render();
    }
  }

  redo() {
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.grid = this.history[this.historyIndex].map(r => [...r]);
      this.render();
    }
  }

  clearGrid() { this.saveHistory(); this.initGrid(); this.render(); }
  setTool(tool: ToolId) { this.activeTool = tool; }
  get canUndo() { return this.historyIndex > 0; }
  get canRedo() { return this.historyIndex < this.history.length - 1; }

  // ─── ARDUINO (Bluetooth Classic / Web Serial) ────────────────────────────

  async toggleArduino() {
    if (this.arduinoConnected) {
      await this.disconnectArduino();
      return;
    }
    this.btError = '';
    if (this.btMode === 'bluetooth') {
      // Si tenemos un HC-05/06 preferido (ultimo usado o emparejado), intentamos
      // conectar directo sin pasar por el picker. Si falla, lo abrimos.
      if (this.preferredDevice) {
        try {
          await this.bt.requestPermissions();
          await this.bt.connect(this.preferredDevice.address);
          this.portName = this.preferredDevice.name;
          this.bt.rememberDevice(this.preferredDevice);
          return;
        } catch (e: any) {
          console.warn('[BT] auto-connect fallo, abriendo picker:', e?.message);
          this.btError = e?.message || '';
        }
      }
      // Abrir el modal inmediatamente con la lista cacheada (si existe) para
      // evitar la espera visible; refrescamos en segundo plano.
      this.showDevicePicker = true;
      this.refreshDevices();
    } else if (this.btMode === 'serial') {
      // Escritorio con Web Serial
      try {
        await this.bt.connect(undefined, parseInt(this.baudRate));
      } catch (e: any) {
        this.btError = e?.message || 'No se pudo conectar';
      }
    } else {
      this.btError = 'Esta plataforma no soporta Bluetooth Serial ni Web Serial.';
    }
  }

  async refreshDevices() {
    // Solo mostramos "Buscando..." si aun no hay nada que mostrar, para que el
    // modal se sienta instantaneo cuando ya habia lista cacheada.
    const hadDevices = this.btDevices.length > 0;
    if (!hadDevices) this.btScanning = true;
    this.btError = '';
    try {
      this.btDevices = await this.bt.listPaired({ force: true });
      this.preferredDevice = this.bt.pickPreferred(this.btDevices);
      if (this.btDevices.length === 0) {
        this.btError = 'No hay dispositivos emparejados. Empareja el HC-05/06 desde Ajustes > Bluetooth.';
      }
    } catch (e: any) {
      this.btError = e?.message || 'Error listando dispositivos';
    } finally {
      this.btScanning = false;
    }
  }

  async reloadPermissions() {
    this.btError = '';
    this.btScanning = true;
    try {
      this.btMode = this.bt.refreshMode();
      await this.bt.requestPermissions();
      this.btDevices = await this.bt.listPaired();
      this.preferredDevice = this.bt.pickPreferred(this.btDevices);
      if (this.btDevices.length === 0) {
        this.btError = 'Permisos concedidos, pero no hay dispositivos emparejados. Empareja el HC-05/06 desde Ajustes > Bluetooth.';
      }
    } catch (e: any) {
      this.btError = e?.message || 'No se pudieron obtener los permisos';
    } finally {
      this.btScanning = false;
    }
  }

  async connectToDevice(device: BtDevice) {
    this.btError = '';
    try {
      await this.bt.connect(device.address);
      this.portName = device.name;
      this.preferredDevice = device;
      this.bt.rememberDevice(device);
      this.showDevicePicker = false;
    } catch (e: any) {
      this.btError = e?.message || 'No se pudo conectar';
    }
  }

  cancelDevicePicker() {
    this.showDevicePicker = false;
  }

  async disconnectArduino() {
    await this.bt.disconnect();
  }

  async sendToArduino() {
    if (!this.arduinoConnected) return;
    this.sending = true;
    this.sendProgress = 0;
    this.btError = '';
    this.setPhase('sending');
    try {
      // Protocolo: [0xFF,0xFE,0xFD] + R,G,B x (96x24) + [0xFD,0xFE,0xFF]
      // El firmware espera SIEMPRE 96x24. Si el lienzo esta en un tamano
      // menor, reescalamos por vecino mas cercano al empaquetar.
      const total = 3 + PROTO_ROWS * PROTO_COLS * 3 + 3;
      const buf = new Uint8Array(total);
      let i = 0;
      buf[i++] = 0xFF; buf[i++] = 0xFE; buf[i++] = 0xFD;
      const rowRatio = this.matrixRows / PROTO_ROWS;
      const colRatio = this.matrixCols / PROTO_COLS;
      for (let r = 0; r < PROTO_ROWS; r++) {
        const srcR = Math.min(this.matrixRows - 1, Math.floor(r * rowRatio));
        for (let c = 0; c < PROTO_COLS; c++) {
          // Espejo horizontal: el modulo FC-16 encadenado invierte el orden
          // de columnas respecto a la app. Empaquetamos la columna opuesta
          // para que "derecha" en el lienzo sea "derecha" en la matriz real.
          const mirroredC = PROTO_COLS - 1 - c;
          const srcC = Math.min(this.matrixCols - 1, Math.floor(mirroredC * colRatio));
          // Binarizamos: cualquier pixel distinto de negro se manda como blanco
          // puro para asegurar que supere el umbral de luminancia del firmware
          // (rojo puro daria Y=76, por debajo del umbral 96 y no se encenderia).
          const on = this.grid[srcR][srcC] !== BLACK;
          if (on) { buf[i++] = 0xFF; buf[i++] = 0xFF; buf[i++] = 0xFF; }
          else    { buf[i++] = 0x00; buf[i++] = 0x00; buf[i++] = 0x00; }
        }
      }
      buf[i++] = 0xFD; buf[i++] = 0xFE; buf[i++] = 0xFF;

      // Los defaults del servicio ya estan ajustados segun plataforma
      // (chunk=64/delay=70ms para BT; chunk=256/sin delay para Web Serial).
      this.firmwareStatus = 'Enviando trama...';
      await this.bt.write(buf, {
        onProgress: (sent, t) => {
          this.sendProgress = Math.round((sent / t) * 100);
        },
      });
      this.sendProgress = 100;
      // No todos los firmwares emiten ACK (sobre todo en Web Serial, donde el
      // reset por DTR puede hacer que el primer probe se pierda). Consideramos
      // la trama entregada al terminar la escritura y volvemos a 'ready' solo.
      this.firmwareStatus = 'Trama enviada.';
      this.setPhase('frame-ok');
      clearTimeout(this.phaseResetTimer);
      this.phaseResetTimer = setTimeout(() => {
        if (!this.arduinoConnected) return;
        this.setPhase(this.firmwareReady ? 'ready' : 'awaiting-fw');
      }, 2000);
    } catch (e: any) {
      console.error('Error enviando:', e?.message);
      this.btError = e?.message || 'Error enviando frame';
      this.firmwareStatus = 'Error enviando';
      this.setPhase('error');
    } finally {
      this.sending = false;
      setTimeout(() => { this.sendProgress = 0; }, 1500);
    }
  }

  hexToRgb(hex: string): { r: number; g: number; b: number } {
    const m = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
             : { r: 0, g: 0, b: 0 };
  }
}
