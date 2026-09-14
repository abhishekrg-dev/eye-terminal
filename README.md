
Eye Terminal — Assistive eye-gaze communication interface powered by Flowstep Canvas, Claude MCP, and real-time MediaPipe webcam tracking for the Contra Flowstep Challenge.
# Blink. Select. Speak.

An eye-controlled communication terminal for people who can't use a mouse, keyboard, or touchscreen. Look at a key, hold your gaze, and blink to type — then have it spoken aloud.

Built with vanilla JS and [MediaPipe FaceMesh](https://developers.google.com/mediapipe) for real-time iris tracking and blink detection, entirely in the browser. No installs, no build tools.

## Features

- **9-point gaze calibration** — maps iris position to screen coordinates before use
- **Dwell + blink selection** — hover on a key to highlight it, blink to select it
- **On-screen QWERTY keyboard** with delete, space, and clear
- **Quick-phrase pills** for common needs (*I'm thirsty*, *I need help*, *Call my caregiver*, etc.)
- **Text-to-speech** via the Web Speech API — speak the typed text or a tapped phrase aloud
- **Live webcam preview** with iris markers, so the user/caregiver can confirm tracking is working
- **Mouse/touch fallback** — every key also responds to a normal click, for testing or as a backup input method

<img width="1448" height="1086" alt="EYE" src="https://github.com/user-attachments/assets/2222a25d-daa2-4af3-a2f1-6aefbccd5afd" />


## How it works

1. **FaceMesh** runs on each webcam frame with `refineLandmarks: true`, giving iris landmarks (468, 473) in addition to the standard face mesh.
2. **Calibration** collects iris position samples at 9 known screen points and builds a mapping from iris position → screen pixels.
3. **Gaze tracking** applies that mapping every frame, with easing and a noise threshold to keep the cursor stable.
4. **Blink detection** computes the Eye Aspect Ratio (EAR) from eyelid landmarks; a sharp EAR drop across a few frames is classified as a blink (not just an idle closed eye).
5. A blink while gazing at a key **activates** that key — typing a character, running an action, or speaking a phrase.

## Requirements

- A webcam
- A browser that supports `getUserMedia` and the Web Speech API (Chrome/Edge recommended)
- Node.js (any recent version) — only to run the local static server

## Running it

Camera access requires a secure context, so opening `index.html` directly (`file://`) won't work. Use the included server:

```bash
node server.js
```

Then open **http://localhost:3000** in your browser and allow camera access.

To use a different port:

```bash
PORT=3001 node server.js
```

## Project structure

```
.
├── index.html    # Screens: landing, calibration, keyboard
├── styles.css    # All styling and layout
├── script.js     # Gaze tracking, blink detection, calibration, TTS
└── server.js     # Zero-dependency static file server (camera needs http, not file://)
```

## Usage

1. Click **START** on the landing screen.
2. Follow the 9 calibration dots — hold your gaze on each one until it fills in (or click **Skip**).
3. On the keyboard screen, look at a key or phrase pill and blink to select it.
4. Tap **Speak** (or blink-select it) to hear the typed text read aloud.
5. Use **Recalibrate** any time tracking feels off.

## Known limitations

- Single-face tracking only (`maxNumFaces: 1`)
- Accuracy depends on lighting and camera position — recalibrate if the user moves
- Calibration is not persisted between page reloads

## License

MIT
