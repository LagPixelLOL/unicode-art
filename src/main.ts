import "./style.css";
import { selectBackend } from "./engine/registry";
import { startApp } from "./ui/app";
import { asciiOnly } from "./ui/text";

function showFatal(failures: { label: string; reasons: string[] }[]): void {
  const box = document.getElementById("fatal")!;
  box.classList.replace("hidden", "flex");
  const list = document.getElementById("fatal-reasons")!;
  for (const f of failures) {
    for (const r of f.reasons) {
      const li = document.createElement("li");
      li.textContent = asciiOnly(`${f.label}: ${r}`);
      list.append(li);
    }
  }
  document.body.dataset.state = "unsupported";
}

const selection = await selectBackend();
if (selection.ok) {
  await startApp(selection.backend);
} else {
  showFatal(selection.failures);
}
