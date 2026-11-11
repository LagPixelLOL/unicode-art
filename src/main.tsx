import "./style.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { selectBackend } from "./engine/registry";
import { App } from "./ui/App";
import { NoticeProvider } from "./ui/notices";
import { Unsupported } from "./ui/Unsupported";

const root = createRoot(document.getElementById("root")!);
const selection = await selectBackend();

root.render(
  <StrictMode>
    {selection.ok ? (
      <NoticeProvider>
        <App backend={selection.backend} />
      </NoticeProvider>
    ) : (
      <Unsupported failures={selection.failures} />
    )}
  </StrictMode>,
);
