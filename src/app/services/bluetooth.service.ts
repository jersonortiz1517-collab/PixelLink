/**
 * BluetoothService - Capa de transporte unica para la app PixelLink.
 * En Android usa cordova-plugin-bluetooth-serial; en escritorio, Web Serial.
 */

import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

export interface BtDevice {
  address: string;
  name: string;
}

export type BtStatus = 'disconnected' | 'connecting' | 'connected';

export type FirmwareEvent =
  | { kind: 'ready' }
  | { kind: 'ack' }
  | { kind: 'nak'; reason: string }
  | { kind: 'other'; line: string };

declare const window: any;

@Injectable({ providedIn: 'root' })
export class BluetoothService {
  readonly status$ = new BehaviorSubject<BtStatus>('disconnected');
  readonly deviceName$ = new BehaviorSubject<string>('');
  readonly firmware$ = new Subject<FirmwareEvent>();

  private mode: 'bluetooth' | 'serial' | 'none' = 'none';
  private serialPort: any = null;
  private serialReader: any = null;
  private serialReaderTask: Promise<void> | null = null;
  private rxLineBuf = '';

  constructor() {
    this.mode = this.detectMode();
  }

  private detectMode(): 'bluetooth' | 'serial' | 'none' {
    if (typeof window !== 'undefined' && window.bluetoothSerial) return 'bluetooth';
    if (typeof navigator !== 'undefined' && 'serial' in (navigator as any)) return 'serial';
    return 'none';
  }

  getMode(): 'bluetooth' | 'serial' | 'none' { return this.mode; }
  isSupported(): boolean { return this.mode !== 'none'; }
  refreshMode(): 'bluetooth' | 'serial' | 'none' { this.mode = this.detectMode(); return this.mode; }

  async requestPermissions(): Promise<void> {
    this.refreshMode();
    if (this.mode !== 'bluetooth') throw new Error('Bluetooth nativo no disponible en esta plataforma');
    const bt = window.bluetoothSerial;
    await new Promise<void>((resolve, reject) => {
      bt.isEnabled(() => resolve(),
        () => { bt.enable(() => resolve(), (err: any) => reject(this.toPermError(err))); });
    });
    await new Promise<void>((resolve, reject) => {
      bt.list(() => resolve(), (err: any) => reject(this.toPermError(err)));
    });
  }

  private toPermError(err: any): Error {
    const raw = typeof err === 'string' ? err : (err?.message || JSON.stringify(err));
    if (/permission/i.test(raw)) {
      return new Error('Faltan permisos de Bluetooth. Abre Ajustes > Apps > PixelLink > Permisos y concede "Dispositivos cercanos" y "Ubicacion".');
    }
    return new Error(raw || 'Error de Bluetooth');
  }

  private toConnError(err: any, method: 'connect' | 'connectInsecure'): Error {
    const raw = typeof err === 'string' ? err : (err?.message || JSON.stringify(err));
    console.error('[BT] ' + method + ' error:', raw);
    if (/permission/i.test(raw)) return new Error('Faltan permisos. Pulsa "Recargar permisos" y acepta el dialogo.');
    if (/read failed|socket|closed/i.test(raw)) return new Error('El modulo rechazo la conexion. Enciende el HC-05/06, acercalo y reintenta.');
    if (/timeout/i.test(raw)) return new Error('Tiempo agotado al conectar. Revisa que el modulo este encendido y emparejado.');
    return new Error(raw || ('Fallo ' + method));
  }

  pickPreferred(devices: BtDevice[]): BtDevice | null {
    if (!devices?.length) return null;
    const lastMac = (typeof localStorage !== 'undefined') ? localStorage.getItem('pixellink.lastMac')?.toUpperCase() : null;
    if (lastMac) {
      const hit = devices.find((d) => d.address?.toUpperCase() === lastMac);
      if (hit) return hit;
    }
    return devices.find((d) => /hc-?0[56]/i.test(d.name || '')) || null;
  }

  rememberDevice(device: BtDevice) {
    try { localStorage?.setItem('pixellink.lastMac', device.address); } catch (_) {}
  }

  async listPaired(): Promise<BtDevice[]> {
    this.refreshMode();
    if (this.mode !== 'bluetooth') return [];
    const bt = window.bluetoothSerial;
    await new Promise<void>((resolve, reject) => {
      bt.isEnabled(() => resolve(),
        () => bt.enable(() => resolve(), (err: any) => reject(this.toPermError(err))));
    });
    return new Promise<BtDevice[]>((resolve, reject) => {
      bt.list((devices: any[]) => {
        const mapped: BtDevice[] = (devices || []).map((d) => ({
          address: d.address || d.id,
          name: d.name || d.address || 'Desconocido',
        }));
        resolve(mapped);
      }, (err: any) => reject(this.toPermError(err)));
    });
  }

  async connect(address?: string, baudRate: number = 115200): Promise<void> {
    this.status$.next('connecting');
    try {
      if (this.mode === 'bluetooth') {
        if (!address) throw new Error('Se requiere la direccion MAC del modulo BT');
        const bt = window.bluetoothSerial;
        const tryConnect = (fn: 'connect' | 'connectInsecure') =>
          new Promise<void>((resolve, reject) => {
            bt[fn](address, () => resolve(), (err: any) => reject(this.toConnError(err, fn)));
          });
        try { await tryConnect('connect'); }
        catch (primary) {
          console.warn('[BT] connect fallo, reintentando connectInsecure:', primary);
          try { await tryConnect('connectInsecure'); }
          catch (secondary) {
            console.error('[BT] connectInsecure tambien fallo:', secondary);
            throw secondary;
          }
        }
        this.deviceName$.next(address);
        this.startBluetoothRead();
      } else if (this.mode === 'serial') {
        this.serialPort = await (navigator as any).serial.requestPort();
        await this.serialPort.open({ baudRate });
        this.deviceName$.next('Puerto serie');
        this.startSerialRead();
      } else {
        throw new Error('No hay transporte Bluetooth ni Web Serial disponible');
      }
      this.status$.next('connected');
      setTimeout(() => { this.probeFirmware().catch(() => {}); }, 200);
    } catch (e) {
      this.status$.next('disconnected');
      this.deviceName$.next('');
      throw e;
    }
  }

  private startBluetoothRead() {
    const bt = window.bluetoothSerial;
    if (!bt || typeof bt.subscribeRawData !== 'function') return;
    this.rxLineBuf = '';
    bt.subscribeRawData(
      (data: ArrayBuffer) => {
        try {
          const bytes = new Uint8Array(data);
          let s = '';
          for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
          this.ingestText(s);
        } catch (_) {}
      },
      (err: any) => console.warn('[BT] subscribeRawData error:', err)
    );
  }

  private async startSerialRead() {
    if (!this.serialPort?.readable) return;
    this.rxLineBuf = '';
    const decoder = new TextDecoder();
    this.serialReaderTask = (async () => {
      try {
        while (this.serialPort && this.serialPort.readable) {
          const reader = this.serialPort.readable.getReader();
          this.serialReader = reader;
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value) this.ingestText(decoder.decode(value, { stream: true }));
            }
          } catch (_) { break; }
          finally {
            try { reader.releaseLock(); } catch (_) {}
            this.serialReader = null;
          }
        }
      } catch (_) {}
    })();
  }

  private ingestText(chunk: string) {
    this.rxLineBuf += chunk;
    let idx: number;
    while ((idx = this.rxLineBuf.search(/[\r\n]/)) >= 0) {
      const line = this.rxLineBuf.slice(0, idx).trim();
      this.rxLineBuf = this.rxLineBuf.slice(idx + 1);
      if (!line) continue;
      this.emitFirmwareLine(line);
    }
    if (this.rxLineBuf.length > 256) this.rxLineBuf = '';
  }

  private emitFirmwareLine(line: string) {
    if (line === 'READY') this.firmware$.next({ kind: 'ready' });
    else if (line === 'ACK') this.firmware$.next({ kind: 'ack' });
    else if (line.startsWith('NAK:')) this.firmware$.next({ kind: 'nak', reason: line.slice(4) });
    else this.firmware$.next({ kind: 'other', line });
  }

  async probeFirmware(): Promise<void> {
    if (this.status$.value !== 'connected') return;
    const probe = new Uint8Array([0x3F]);
    try { await this.write(probe, { chunkSize: 1, chunkDelayMs: 0 }); } catch (_) {}
  }

  async disconnect(): Promise<void> {
    try {
      if (this.mode === 'bluetooth' && window.bluetoothSerial) {
        const bt = window.bluetoothSerial;
        try { bt.unsubscribeRawData?.(() => {}, () => {}); } catch (_) {}
        await new Promise<void>((resolve) => { bt.disconnect(() => resolve(), () => resolve()); });
      } else if (this.mode === 'serial' && this.serialPort) {
        try { await this.serialReader?.cancel(); } catch (_) {}
        try { await this.serialPort.close(); } catch (_) {}
        this.serialPort = null;
        this.serialReader = null;
        this.serialReaderTask = null;
      }
    } finally {
      this.rxLineBuf = '';
      this.status$.next('disconnected');
      this.deviceName$.next('');
    }
  }

  async write(
    data: Uint8Array,
    opts: { chunkSize?: number; chunkDelayMs?: number; onProgress?: (sent: number, total: number) => void } = {}
  ): Promise<void> {
    if (this.status$.value !== 'connected') throw new Error('No conectado');
    const isBt = this.mode === 'bluetooth';
    const chunkSize = opts.chunkSize ?? (isBt ? 64 : 256);
    const chunkDelayMs = opts.chunkDelayMs ?? (isBt ? 70 : 0);

    if (this.mode === 'bluetooth') {
      const bt = window.bluetoothSerial;
      let sent = 0;
      while (sent < data.length) {
        const end = Math.min(sent + chunkSize, data.length);
        const chunk = data.slice(sent, end);
        await new Promise<void>((resolve, reject) => {
          bt.write(chunk.buffer, () => resolve(), (err: any) => reject(err));
        });
        sent = end;
        if (opts.onProgress) opts.onProgress(sent, data.length);
        if (sent < data.length && chunkDelayMs > 0) {
          await new Promise((r) => setTimeout(r, chunkDelayMs));
        }
      }
    } else if (this.mode === 'serial' && this.serialPort) {
      const writer = this.serialPort.writable.getWriter();
      try {
        let sent = 0;
        while (sent < data.length) {
          const end = Math.min(sent + chunkSize, data.length);
          await writer.write(data.slice(sent, end));
          sent = end;
          if (opts.onProgress) opts.onProgress(sent, data.length);
        }
      } finally { writer.releaseLock(); }
    } else {
      throw new Error('Transporte no disponible');
    }
  }

  get connected(): boolean { return this.status$.value === 'connected'; }
}
