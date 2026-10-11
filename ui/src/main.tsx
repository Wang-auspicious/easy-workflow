import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/canvas.css";
import "./styles/panels.css";
import "./styles/studio.css";
import { App } from "./App.tsx";
import { boot } from "./api.ts";

createRoot(document.getElementById("root")!).render(<App />);
boot().catch((err) => {
  console.error(err);
  document.body.dataset.bootError = String(err);
});
