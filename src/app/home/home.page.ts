import { Component } from '@angular/core';
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
export class HomePage {
  conectado = false;
  estado = 'Desconectado';
  mensaje = '';
  deviceId = '';

  async conectar() {
    try {
      this.estado = 'Inicializando BLE...';
      await BleClient.initialize({ androidNeverForLocation: true });

      this.estado = 'Selecciona tu dispositivo...';
      const device = await BleClient.requestDevice({
        namePrefix: 'PIXEL',
        services: [],
        optionalServices: [SERVICE_UUID],
        allowDuplicates: false
      });

      this.deviceId = device.deviceId;
      this.estado = 'Conectando...';

      await BleClient.connect(device.deviceId, () => {
        this.conectado = false;
        this.estado = 'Desconectado del dispositivo';
      });

      // Recibir datos del Arduino
      await BleClient.startNotifications(
        device.deviceId, SERVICE_UUID, CHAR_UUID,
        (value) => {
          const txt = dataViewToText(value);
          console.log('Recibido:', txt);
          this.estado = 'RX: ' + txt;
        }
      );

      this.conectado = true;
      this.estado = 'Conectado ✅';
    } catch (e: any) {
      this.estado = 'Error: ' + (e.message || JSON.stringify(e));
    }
  }

  async enviar() {
    if (!this.mensaje || !this.deviceId) return;
    try {
      const bytes = Array.from(new TextEncoder().encode(this.mensaje + '\n'));
      const data = numbersToDataView(bytes);
      await BleClient.writeWithoutResponse(this.deviceId, SERVICE_UUID, CHAR_UUID, data);
      this.estado = 'Enviado: ' + this.mensaje;
      this.mensaje = '';
    } catch (e: any) {
      this.estado = 'Error envío: ' + (e.message || e);
    }
  }
}