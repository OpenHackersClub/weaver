import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
// StrictMode is intentionally off until the editor's lifecycle is wrapped in an
// Effect-TS Layer (ADR 0007). Loro's WASM-backed LoroDoc and the contenteditable
// DOM bridge are not safe under React's simulated unmount/remount.
createRoot(root).render(<App />);
