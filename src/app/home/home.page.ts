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
  removeCircleOutline, colorWandOutline, refreshOutline, closeCircleOutline
} from 'ionicons/icons';
import { BluetoothService, BtDevice, FirmwareEvent } from '../services/bluetooth.service';
import { Subscription } from 'rxjs';

const ROWS = 24;
const COLS = 96;
const MAX_HISTORY = 20;
const BLACK = '#000000';

type ToolId = 'pencil' | 'eraser' | 'rect' | 'circle' | 'line' | 'fill' | 'eyedropper';

interface ShapeDef {
  id: string;
  name: string;
  color: string;
  pattern: string[];
  previewUrl?: string;
}

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [IonHeader, IonToolbar, IonContent, IonIcon, CommonModule, FormsModule],
})
export class HomePage implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('ledCanvas', { static: false }) canvasRef!: ElementRef<HTMLCanvasElement>;

  grid: string[][] = [];
  isDrawing = false;
  activeTool: ToolId = 'pencil';
  currentColor = '#ff2d55';
  cellSize = 8;
  showGrid = true;
  startCell = { row: 0, col: 0 };
  cursorPos = { row: 0, col: 0 };
  history: string[][][] = [];
  historyIndex = -1;

  arduinoConnected = false;
  portName = '';
  baudRate = '115200';
  sending = false;
  sendProgress = 0;
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
    { id: 'pencil',     icon: 'pencil-outline',        label: 'Lápiz',       key: 'P' },
    { id: 'eraser',     icon: 'remove-circle-outline', label: 'Borrador',    key: 'E' },
    { id: 'rect',       icon: 'square-outline',        label: 'Rectángulo',  key: 'R' },
    { id: 'circle',     icon: 'ellipse-outline',       label: 'Círculo',     key: 'C' },
    { id: 'line',       icon: 'remove-outline',        label: 'Línea',       key: 'L' },
    { id: 'fill',       icon: 'color-fill-outline',    label: 'Relleno',     key: 'F' },
    { id: 'eyedropper', icon: 'color-wand-outline',    label: 'Cuentagotas', key: 'I' },
  ];

  palette = [
    '#ff0000', '#ff4400', '#ff8800', '#ffcc00', '#ffff00',
    '#88ff00', '#00ff00', '#00ff88', '#00ffff', '#0088ff',
    '#0000ff', '#8800ff', '#ff00ff', '#ff0088', '#ff3b30',
    '#ffffff', '#aaaaaa', '#555555', '#222222', '#00d4ff',
  ];

  referenceShapes: ShapeDef[] = [
    {
      id: 'heart', name: 'Corazón', color: '#ff2d55',
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
      id: 'star', name: 'Estrella', color: '#ffd60a',
      pattern: [
        '...X...',
        '.XXXXX.',
        'XXXXXXX',
        '..XXX..',
        '.X.X.X.',
        'X.....X',
      ]
    },
    {
      id: 'arrow', name: 'Flecha →', color: '#30d158',
      pattern: [
        '..XX....',
        '.....X..',
        'XXXXXXXX',
        '.....X..',
        '..XX....',
      ]
    },
    {
      id: 'smiley', name: 'Carita :)', color: '#ffd60a',
      pattern: [
        '.XXXXXX.',
        'X......X',
        'X.X..X.X',
        'X......X',
        'X.XXXX.X',
        'X......X',
        '.XXXXXX.',
      ]
    },
    {
      id: 'lightning', name: 'Rayo', color: '#ffd60a',
      pattern: [
        '...XXXX',
        '..XX...',
        '.XXXXXX',
        'XX.....',
        'XXXXX..',
        '..XX...',
        '...X...',
      ]
    },
    {
      id: 'minecraft', name: 'MINECRAFT', color: '#4a8f3f',
      pattern: (() => {
        const lm: Record<string, string[]> = {
          M: ['X...X','XX.XX','X.X.X','X...X','X...X'],
          I: ['.XXX.','..X..','..X..','..X..','.XXX.'],
          N: ['X...X','XX..X','X.X.X','X..XX','X...X'],
          E: ['XXXXX','X....','XXXX.','X....','XXXXX'],
          C: ['.XXXX','X....','X....','X....', '.XXXX'],
          R: ['XXXX.','X...X','XXXX.','X.X..','X..XX'],
          A: ['..X..','.X.X.','XXXXX','X...X','X...X'],
          F: ['XXXXX','X....','XXXX.','X....','X....'],
          T: ['XXXXX','..X..','..X..','..X..','..X..'],
        };
        const word = 'MINECRAFT';
        const lw = 5, lh = 5, sp = 2;
        const totalW = word.length * lw + (word.length - 1) * sp; // 61
        const sC = Math.floor((COLS - totalW) / 2);               // 17
        const sR = Math.floor((ROWS - lh) / 2);                   // 9
        return Array.from({ length: ROWS }, (_, r) => {
          const row = Array(COLS).fill('.');
          const lr = r - sR;
          if (lr >= 0 && lr < lh) {
            [...word].forEach((ch, li) => {
              const cStart = sC + li * (lw + sp);
              [...lm[ch][lr]].forEach((px, lc) => {
                if (px === 'X') row[cStart + lc] = 'X';
              });
            });
          }
          return row.join('');
        });
      })()
    },
    {
      id: 'checkerboard', name: 'Tablero', color: '#ffffff',
      pattern: [
        'X.X.X.X.',
        '.X.X.X.X',
        'X.X.X.X.',
        '.X.X.X.X',
        'X.X.X.X.',
        '.X.X.X.X',
        'X.X.X.X.',
        '.X.X.X.X',
      ]
    },
    {
      id: 'text_hi', name: 'Texto HI', color: '#00d4ff',
      pattern: [
        'X...X..X.',
        'X...X..X.',
        'XXXXX..X.',
        'X...X..X.',
        'X...X..X.',
      ]
    },
    {
      id: 'diamond', name: 'Diamante', color: '#bf5af2',
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
      id: 'pacman', name: 'Pac-Man', color: '#ffd60a',
      pattern: [
        '.XXXXX.',
        'XXXXXXX',
        'XXXXX..',
        'XXXX...',
        'XXXXX..',
        'XXXXXXX',
        '.XXXXX.',
      ]
    },
  ];

  ngOnInit() {
    addIcons({
      pencilOutline, squareOutline, ellipseOutline, removeOutline,
      colorFillOutline, trashOutline, sendOutline,
      arrowUndoOutline, arrowRedoOutline, bluetoothOutline, bluetooth,
      removeCircleOutline, colorWandOutline, refreshOutline, closeCircleOutline,
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
    this.resizeCanvas();
    this.render();
    setTimeout(() => {
      this.referenceShapes.forEach(s => { s.previewUrl = this.generateShapePreview(s); });
    }, 50);
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
    this.grid = Array.from({ length: ROWS }, () => Array(COLS).fill(BLACK));
  }

  resizeCanvas() {
    const canvas = this.canvasRef.nativeElement;
    const g = this.showGrid ? 1 : 0;
    canvas.width  = COLS * (this.cellSize + g) + g;
    canvas.height = ROWS * (this.cellSize + g) + g;
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

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
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
    if (this.activeTool === 'eyedropper') {
      const c = this.grid[cell.row][cell.col];
      if (c !== BLACK) this.currentColor = c;
      this.activeTool = 'pencil';
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
        c: 'circle', l: 'line',   f: 'fill', i: 'eyedropper'
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
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
    return { row, col };
  }

  paintCell(grid: string[][], row: number, col: number, color: string) {
    if (row >= 0 && row < ROWS && col >= 0 && col < COLS) grid[row][col] = color;
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
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS || this.grid[r][c] !== oldColor) continue;
      this.grid[r][c] = newColor;
      stack.push([r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]);
    }
  }

  // ─── FIGURAS ─────────────────────────────────────────────────────────────

  applyShape(shape: ShapeDef) {
    this.saveHistory();
    const h = shape.pattern.length;
    const w = Math.max(...shape.pattern.map(row => row.length));
    const startR = Math.max(0, Math.floor((ROWS - h) / 2));
    const startC = Math.max(0, Math.floor((COLS - w) / 2));
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < shape.pattern[r].length; c++) {
        if (shape.pattern[r][c] === 'X')
          this.paintCell(this.grid, startR + r, startC + c, shape.color);
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
      this.showDevicePicker = true;
      await this.refreshDevices();
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
    this.btScanning = true;
    this.btError = '';
    try {
      this.btDevices = await this.bt.listPaired();
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
      const total = 3 + ROWS * COLS * 3 + 3;
      const buf = new Uint8Array(total);
      let i = 0;
      buf[i++] = 0xFF; buf[i++] = 0xFE; buf[i++] = 0xFD;
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const rgb = this.hexToRgb(this.grid[r][c]);
          buf[i++] = rgb.r; buf[i++] = rgb.g; buf[i++] = rgb.b;
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
      this.firmwareStatus = 'Trama enviada. Esperando ACK...';
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
