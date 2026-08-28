import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";

window.ServiceConsoleTerminal = Object.freeze({
  Terminal,
  FitAddon,
  SearchAddon,
  WebLinksAddon,
});
