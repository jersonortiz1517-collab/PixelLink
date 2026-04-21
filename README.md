# PixelLink

Editor de píxeles en tiempo real para matrices LED RGB de **24 × 96** celdas, con envío directo a Arduino vía Web Serial API.

## Características

- **Canvas interactivo** — dibuja, borra y rellena celdas con herramientas al estilo pixel-art
- **Herramientas de dibujo** — lápiz, borrador, rectángulo, círculo, línea, relleno (flood-fill) y cuentagotas
- **Figuras prediseñadas** — patrones listos para aplicar: corazón, estrella, carita, rayo, tablero, texto HI, diamante, Pac-Man y el texto **MINECRAFT** en fuente pixel que ocupa toda la pantalla
- **Paleta de colores** — 20 colores predefinidos + selector nativo + campo HEX
- **Undo / Redo** — hasta 20 pasos de historial
- **Zoom ajustable** — de 3 px a 16 px por celda
- **Cuadrícula opcional** — activa o desactiva la rejilla de separación
- **Conexión Arduino** — protocolo binario via Web Serial API (Chrome / Edge escritorio)
- **PWA / Android / iOS** — empaquetable con Capacitor como app nativa

## Tecnologías

| Capa | Tecnología |
|------|-----------|
| Framework | Angular 20 (standalone components) |
| UI | Ionic 8 + ionicons |
| Native | Capacitor 7 |
| Canvas | HTML5 Canvas API |
| Serial | Web Serial API |

## Requisitos previos

- **Node.js** ≥ 18
- **npm** ≥ 9
- Google Chrome o Microsoft Edge (para Web Serial API)

## Instalación y ejecución

```bash
# Instalar dependencias
npm install

# Servidor de desarrollo
npm start
# → http://localhost:4200

# Build de producción
npx ng build
```

## Herramientas y atajos de teclado

| Tecla | Herramienta |
|-------|-------------|
| `P` | Lápiz |
| `E` | Borrador |
| `R` | Rectángulo |
| `C` | Círculo |
| `L` | Línea |
| `F` | Relleno (flood-fill) |
| `I` | Cuentagotas |
| `Ctrl + Z` | Deshacer |
| `Ctrl + Y` | Rehacer |

## Protocolo Arduino

El envío es un paquete binario de **6 918 bytes**:

```
[0xFF 0xFE 0xFD]  ← marcador de inicio (3 bytes)
R G B × 2304      ← un byte por canal por cada celda, orden fila a fila (6 912 bytes)
[0xFD 0xFE 0xFF]  ← marcador de fin (3 bytes)
```

Las celdas se envían de izquierda a derecha, de arriba a abajo (fila 0 col 0 … fila 23 col 95).

## Estructura del proyecto

```
src/
├── app/
│   └── home/
│       ├── home.page.ts      # Lógica principal del editor
│       ├── home.page.html    # Plantilla: toolbar, canvas, paneles
│       └── home.page.scss    # Estilo oscuro LED con acento cyan
└── assets/
    └── icon/                 # Iconos PWA y favicon
```

## Despliegue en Android / iOS

```bash
# Compilar y sincronizar con Capacitor
npx ng build && npx cap sync

# Abrir proyecto nativo
npx cap open android
npx cap open ios
```

## Licencia

MIT
