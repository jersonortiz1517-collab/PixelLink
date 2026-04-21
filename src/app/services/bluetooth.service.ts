/**
 * BluetoothService
 * -----------------------------------------------------------------------------
 * Capa de transporte unica para la app PixelLink.
 *
 *  - En Android (empaquetado con Capacitor) usa Bluetooth Classic SPP a traves
 *    del plugin Cordova `cordova-plugin-bluetooth-serial` (wrapper de Awesome
 *    Cordova Plugins). Compatible con modulos HC-05 / HC-06.
 *
 *  - En un navegador de escritorio (Chrome/Edge) cae a la Web Serial API,
 *    para que se pueda seguir usando la app conectandose al Arduino por USB.
 *
 *  Expone la misma API para los dos casos, para que el componente Home no
 *  tenga que preocuparse por la plataforma.
 */

import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface BtDevice {
  address: string;
  name: string;
}

export type BtStatus = 'disconnected' | 'connecting' | 'connected';

declare const window: any;

@Injectable({ providedIn: 'root' })
export class BluetoothService {
  readonly status$ = new BehaviorSubject<BtStatus>('disconnected');
  readonly deviceName$ = new BehaviorSubject<string>('');

  private mode: 'bluetooth' | 'serial' | 'none' = 'none';
  private serialPort: any = null;

  constructor() {
    this.mode = this.detectMode();
  }

  // --------------------------------------------------------------------------
  // Deteccion de plataforma
  // --------------------------------------------------------------------------
  private detectMode(): 'bluetooth' | 'serial' | 'none' {
    // 1) Cordova/Capacitor (Android): `cordova-plugin-bluetooth-serial`
    //    expone `window.bluetoothSerial`.
    if (typeof window !== 'undefined' && window.bluetoothSerial) {
      return 'bluetooth';
    }
    // 2) Navegador con Web Serial API (Chrome/Edge en escritorio).
    if (typeof navigator !== 'undefined' && 'serial' in (navigator as any)) {
      return 'serial';
    }
    return 'none';
  }

  /** Devuelve 'bluetooth' | 'serial' | 'none' segun lo disponible. */
  getMode(): 'bluetooth' | 'serial' | 'none' {
    return this.mode;
  }

  isSupported(): boolean {
    return this.mode !== 'none';
  }

  // --------------------------------------------------------------------------
  // Listar dispositivos emparejados (solo Bluetooth)
  // --------------------------------------------------------------------------
  async listPaired(): Promise<BtDevice[]> {
    if (this.mode !== 'bluetooth') return [];
    const bt = window.bluetoothSerial;
    // Aseguramos que el BT este encendido
    try {
      await new Promise<void>((resolve) => {
        bt.isEnabled(() => resolve(), () => bt.enable(() => resolve(), () => resolve()));
      });
    } catch (_) {}
    return new Promise<BtDevice[]>((resolve, reject) => {
      bt.list(
        (devices: any[]) => {
          const mapped: BtDevice[] = (devices || []).map((d) => ({
            address: d.address || d.id,
            name: d.name || d.address || 'Desconocido',
          }));
          resolve(mapped);
        },
        (err: any) => reject(err)
      );
    });
  }

  // --------------------------------------------------------------------------
  // Conectar
  // --------------------------------------------------------------------------
  async connect(address?: string, baudRate: number = 115200): Promise<void> {
    this.status$.next('connecting');
    try {
      if (this.mode === 'bluetooth') {
        if (!address) throw new Error('Se requiere la direccion MAC del modulo BT');
        await new Promise<void>((resolve, reject) => {
          window.bluetoothSerial.connect(
            address,
            () => resolve(),
            (err: any) => reject(err)
          );
        });
        this.deviceName$.next(address);
      } else if (this.mode === 'serial') {
        this.serialPort = await (navigator as any).serial.requestPort();
        await this.serialPort.open({ baudRate });
        this.deviceName$.next('Puerto serie');
      } else {
        throw new Error('No hay transporte Bluetooth ni Web Serial disponible');
      }
      this.status$.next('connected');
    } catch (e) {
      this.status$.next('disconnected');
      this.deviceName$.next('');
      throw e;
    }
  }

  // --------------------------------------------------------------------------
  // Desconectar
  // --------------------------------------------------------------------------
  async disconnect(): Promise<void> {
    try {
      if (this.mode === 'bluetooth' && window.bluetoothSerial) {
        await new Promise<void>((resolve) => {
          window.bluetoothSerial.disconnect(() => resolve(), () => resolve());
        });
      } else if (this.mode === 'serial' && this.serialPort) {
        try { await this.serialPort.close(); } catch (_) {}
        this.serialPort = null;
      }
    } finally {
      this.status$.next('disconnected');
      this.deviceName$.next('');
    }
  }

  // --------------------------------------------------------------------------
  // Escribir bytes. Se trocea en chunks para BT (SPP tiene MTU limitada) y se
  // espera a que el Arduino los vaya consumiendo.
  // --------------------------------------------------------------------------
  async write(
    data: Uint8Array,
    opts: { chunkSize?: number; chunkDelayMs?: number; onProgress?: (sent: number, total: number) => void } = {}
  ): Promise<void> {
    if (this.status$.value !== 'connected') throw new Error('No conectado');
    const chunkSize = opts.chunkSize ?? 256;
    const chunkDelayMs = opts.chunkDelayMs ?? 8;

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
      } finally {
        writer.releaseLock();
      }
    } else {
      throw new Error('Transporte no disponible');
    }
  }

  get connected(): boolean {
    return this.status$.value === 'connected';
  }
}
