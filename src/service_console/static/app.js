(() => {
  "use strict";

  const MAX_LOG_ENTRIES = 2000;
  const SERVICE_POLL_INTERVAL = 5000;
  const PORT_POLL_INTERVAL = 5000;
  const HEALTH_POLL_INTERVAL = 15000;
  const token = new URLSearchParams(window.location.search).get("token") || "";

  const state = {
    services: new Map(),
    selectedService: null,
    logBuffers: new Map(),
    logVersions: new Map(),
    loadedLogs: new Set(),
    busyServices: new Set(),
    filter: "",
    autoScroll: localStorage.getItem("service-console:auto-scroll") !== "false",
    socket: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    servicesDrawerOpen: false,
    activeView: window.location.hash === "#ports" ? "ports" : "services",
    ports: [],
    portFilter: null,
    portsLoaded: false,
    loadingPorts: false,
    busyPids: new Set(),
    servicePollTimer: null,
    portPollTimer: null,
    healthPollTimer: null,
    serviceFormMode: "create",
    editingServiceName: null,
  };

  let terminal = null;
  let fitAddon = null;
  let searchAddon = null;
  let terminalResizeObserver = null;
  let terminalFitFrame = null;
  let terminalReplayRevision = 0;
  let terminalReplayActive = false;
  let terminalReplayService = null;
  let terminalPendingEntries = [];

  const elements = {
    apiStatus: document.querySelector("#apiStatus"),
    socketStatus: document.querySelector("#socketStatus"),
    refreshButton: document.querySelector("#refreshButton"),
    openAddButton: document.querySelector("#openAddButton"),
    servicesViewButton: document.querySelector("#servicesViewButton"),
    portsViewButton: document.querySelector("#portsViewButton"),
    servicesWorkspace: document.querySelector("#servicesWorkspace"),
    portsWorkspace: document.querySelector("#portsWorkspace"),
    serviceCount: document.querySelector("#serviceCount"),
    runningSummary: document.querySelector("#runningSummary"),
    serviceSearch: document.querySelector("#serviceSearch"),
    serviceList: document.querySelector("#serviceList"),
    servicesPanel: document.querySelector("#servicesPanel"),
    mobileServicesButton: document.querySelector("#mobileServicesButton"),
    mobileServicesBackdrop: document.querySelector("#mobileServicesBackdrop"),
    closeServicesButton: document.querySelector("#closeServicesButton"),
    mobileSelectedService: document.querySelector("#mobileSelectedService"),
    mobileSelectedStatusDot: document.querySelector("#mobileSelectedStatusDot"),
    consoleTitle: document.querySelector("#consoleTitle"),
    selectedStatus: document.querySelector("#selectedStatus"),
    selectedStatusDot: document.querySelector("#selectedStatusDot"),
    selectedDescription: document.querySelector("#selectedDescription"),
    autoScrollToggle: document.querySelector("#autoScrollToggle"),
    searchLogsButton: document.querySelector("#searchLogsButton"),
    clearLogsButton: document.querySelector("#clearLogsButton"),
    terminal: document.querySelector("#terminal"),
    terminalPlaceholder: document.querySelector("#terminalPlaceholder"),
    xtermHost: document.querySelector("#xtermHost"),
    terminalSearch: document.querySelector("#terminalSearch"),
    terminalSearchInput: document.querySelector("#terminalSearchInput"),
    terminalSearchStatus: document.querySelector("#terminalSearchStatus"),
    terminalSearchPrevious: document.querySelector("#terminalSearchPrevious"),
    terminalSearchNext: document.querySelector("#terminalSearchNext"),
    terminalSearchClose: document.querySelector("#terminalSearchClose"),
    serviceDialog: document.querySelector("#serviceDialog"),
    serviceForm: document.querySelector("#serviceForm"),
    serviceDialogEyebrow: document.querySelector("#serviceDialogEyebrow"),
    serviceDialogTitle: document.querySelector("#serviceDialogTitle"),
    serviceDialogDescription: document.querySelector("#serviceDialogDescription"),
    serviceNameInput: document.querySelector("#serviceNameInput"),
    serviceNameHelp: document.querySelector("#serviceNameHelp"),
    closeServiceDialogButton: document.querySelector("#closeServiceDialogButton"),
    cancelServiceDialogButton: document.querySelector("#cancelServiceDialogButton"),
    submitServiceButton: document.querySelector("#submitServiceButton"),
    portCount: document.querySelector("#portCount"),
    portsSummary: document.querySelector("#portsSummary"),
    portFilterForm: document.querySelector("#portFilterForm"),
    portFilterInput: document.querySelector("#portFilterInput"),
    clearPortFilterButton: document.querySelector("#clearPortFilterButton"),
    portTableWrap: document.querySelector("#portTableWrap"),
    portTableBody: document.querySelector("#portTableBody"),
    toastRegion: document.querySelector("#toastRegion"),
  };

  const icons = {
    start: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
    restart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 5.66M20 5v6h-6"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 6.5 17.5 10.5M4 20l4.2-1 10.3-10.3a2.8 2.8 0 0 0-4-4L4.2 15 4 20Z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>',
    terminate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  };

  function scheduleTerminalFit() {
    if (!fitAddon || !elements.xtermHost) return;
    if (terminalFitFrame !== null) window.cancelAnimationFrame(terminalFitFrame);
    terminalFitFrame = window.requestAnimationFrame(() => {
      terminalFitFrame = null;
      if (
        state.activeView !== "services"
        || elements.servicesWorkspace.hidden
        || elements.xtermHost.clientWidth === 0
        || elements.xtermHost.clientHeight === 0
      ) return;
      try {
        fitAddon.fit();
      } catch {
        // 布局切换期间容器可能短暂不可见，下一次 ResizeObserver 会重试。
      }
    });
  }

  function openTerminalLink(event, uri) {
    event?.preventDefault?.();
    try {
      const url = new URL(uri);
      if (!["http:", "https:"].includes(url.protocol)) return;
      window.open(url.href, "_blank", "noopener,noreferrer");
    } catch {
      // 忽略输出中的无效链接。
    }
  }

  function initializeTerminal() {
    const terminalLibrary = window.ServiceConsoleTerminal;
    if (!terminalLibrary) {
      setTerminalPlaceholder("终端组件加载失败", "请重新构建本地 Web 静态资源后再启动");
      elements.searchLogsButton.disabled = true;
      return false;
    }

    const { Terminal, FitAddon, SearchAddon, WebLinksAddon } = terminalLibrary;
    terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.42,
      scrollback: MAX_LOG_ENTRIES * 5,
      theme: {
        background: "#111a27",
        foreground: "#d5deea",
        cursor: "#d5deea",
        selectionBackground: "#43658f99",
        selectionInactiveBackground: "#34485f80",
        scrollbarSliderBackground: "#48556a99",
        scrollbarSliderHoverBackground: "#607089cc",
        scrollbarSliderActiveBackground: "#71839eff",
        black: "#111a27",
        brightBlack: "#68768a",
        red: "#f28c98",
        brightRed: "#ff9ba6",
        green: "#73d3a4",
        brightGreen: "#8fe6bb",
        yellow: "#e7bd76",
        brightYellow: "#f3ce8c",
        blue: "#76a7f5",
        brightBlue: "#95bafa",
        magenta: "#c5a3ef",
        brightMagenta: "#d8bbfa",
        cyan: "#72c7d5",
        brightCyan: "#8edce8",
        white: "#d5deea",
        brightWhite: "#f2f5f9",
      },
    });
    fitAddon = new FitAddon();
    searchAddon = new SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(new WebLinksAddon(openTerminalLink));
    terminal.open(elements.xtermHost);

    if (typeof ResizeObserver === "function") {
      terminalResizeObserver = new ResizeObserver(scheduleTerminalFit);
      terminalResizeObserver.observe(elements.xtermHost);
    }
    document.fonts?.ready.then(scheduleTerminalFit).catch(() => {});
    scheduleTerminalFit();
    return true;
  }

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }

  function setConnectionState(element, connectionState, label) {
    element.dataset.state = connectionState;
    element.lastElementChild.textContent = label;
  }

  function errorMessage(payload, fallback) {
    if (!payload) return fallback;
    if (typeof payload === "string") return payload;
    const detail = payload.detail ?? payload.message ?? payload.error;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail.map((item) => item?.msg || item?.message || String(item)).join("；");
    }
    return fallback;
  }

  async function apiRequest(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);

    let body = options.body;
    if (body && typeof body !== "string") {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(path, { ...options, headers, body });
    } catch (error) {
      throw new ApiError(`连接服务端失败：${error.message}`, 0);
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      throw new ApiError(errorMessage(payload, `请求失败（HTTP ${response.status}）`), response.status);
    }
    return payload;
  }

  function asNumber(...values) {
    for (const value of values) {
      if (value !== null && value !== undefined && value !== "") {
        const number = Number(value);
        if (Number.isFinite(number)) return number;
      }
    }
    return null;
  }

  function normalizeService(raw, fallbackName = "") {
    const source = raw && typeof raw === "object" ? raw : {};
    const definition = source.definition && typeof source.definition === "object" ? source.definition : {};
    const runtime = source.runtime && typeof source.runtime === "object" ? source.runtime : {};
    const metrics = source.metrics && typeof source.metrics === "object"
      ? source.metrics
      : runtime.metrics && typeof runtime.metrics === "object" ? runtime.metrics : {};
    const status = String(source.status ?? source.state ?? runtime.status ?? runtime.state ?? "STOPPED").toUpperCase();

    return {
      name: String(source.name ?? definition.name ?? fallbackName),
      command: String(source.command ?? definition.command ?? ""),
      cwd: String(source.cwd ?? definition.cwd ?? ""),
      env: source.env ?? definition.env ?? {},
      autoStart: Boolean(source.auto_start ?? definition.auto_start ?? false),
      stopTimeout: asNumber(source.stop_timeout, definition.stop_timeout) ?? 10,
      status,
      pid: asNumber(source.pid, runtime.pid),
      uptimeSeconds: asNumber(source.uptime_seconds, source.uptime, runtime.uptime_seconds, runtime.uptime),
      startedAt: source.started_at ?? source.start_time ?? runtime.started_at ?? runtime.start_time ?? null,
      cpuPercent: asNumber(source.cpu_percent, source.cpu, runtime.cpu_percent, runtime.cpu, metrics.cpu_percent, metrics.cpu),
      memoryBytes: asNumber(source.memory_bytes, source.memory_rss, runtime.memory_bytes, runtime.memory_rss, metrics.memory_bytes, metrics.memory_rss),
      memoryPercent: asNumber(source.memory_percent, runtime.memory_percent, metrics.memory_percent),
      exitCode: asNumber(source.exit_code, runtime.exit_code),
      raw: source,
    };
  }

  function extractServices(payload) {
    let services = Array.isArray(payload) ? payload : payload?.services ?? payload?.data ?? [];
    if (!Array.isArray(services) && services && typeof services === "object") {
      services = Object.entries(services).map(([name, service]) => ({ name, ...(service || {}) }));
    }
    return Array.isArray(services)
      ? services.map((service) => normalizeService(service)).filter((service) => service.name)
      : [];
  }

  function normalizePort(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const commandValue = source.command ?? source.cmdline ?? "";
    const command = Array.isArray(commandValue) ? commandValue.join(" ") : String(commandValue || "");
    return {
      protocol: String(source.protocol ?? "tcp").toUpperCase(),
      localAddress: String(source.local_address ?? source.address ?? ""),
      port: asNumber(source.port, source.local_port),
      pid: asNumber(source.pid),
      processName: String(source.process_name ?? source.name ?? "未知进程"),
      command,
      username: String(source.username ?? source.user ?? "—"),
    };
  }

  function extractPorts(payload) {
    const ports = Array.isArray(payload) ? payload : payload?.ports ?? payload?.data ?? [];
    if (!Array.isArray(ports)) return [];
    return ports
      .map(normalizePort)
      .filter((item) => Number.isInteger(item.port) && item.port >= 1 && item.port <= 65535)
      .sort((left, right) => left.port - right.port || (left.pid ?? 0) - (right.pid ?? 0));
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "—";
    const whole = Math.floor(seconds);
    const days = Math.floor(whole / 86400);
    const hours = Math.floor((whole % 86400) / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const remainingSeconds = whole % 60;
    if (days > 0) return `${days}天 ${hours}时`;
    if (hours > 0) return `${hours}时 ${minutes}分`;
    if (minutes > 0) return `${minutes}分 ${remainingSeconds}秒`;
    return `${remainingSeconds}秒`;
  }

  function currentUptime(service) {
    if (service.status !== "RUNNING" && service.status !== "STARTING") return null;
    if (service.startedAt) {
      const start = new Date(service.startedAt).getTime();
      if (Number.isFinite(start)) return Math.max(0, (Date.now() - start) / 1000);
    }
    return service.uptimeSeconds;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    const digits = value >= 100 || index === 0 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)} ${units[index]}`;
  }

  function formatPercent(value) {
    if (!Number.isFinite(value)) return "—";
    return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
  }

  function statusClass(status) {
    const normalized = String(status || "unknown").toLowerCase();
    return ["running", "starting", "stopping", "stopped", "exited", "failed"].includes(normalized)
      ? normalized
      : "unknown";
  }

  function statusLabel(status) {
    const labels = {
      RUNNING: "运行中",
      STARTING: "启动中",
      STOPPING: "停止中",
      STOPPED: "已停止",
      EXITED: "已退出",
      FAILED: "失败",
    };
    return labels[status] || "未知";
  }

  function metricElement(label, value, dataAttribute = null) {
    const metric = document.createElement("div");
    metric.className = "metric";
    const labelElement = document.createElement("span");
    labelElement.className = "metric-label";
    labelElement.textContent = label;
    const valueElement = document.createElement("span");
    valueElement.className = "metric-value";
    valueElement.textContent = value;
    if (dataAttribute) valueElement.dataset.uptimeService = dataAttribute;
    metric.append(labelElement, valueElement);
    return metric;
  }

  function actionButton(action, label, disabled, { iconOnly = false } = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `action-button${iconOnly ? " action-button-icon" : ""}`;
    button.dataset.action = action;
    button.disabled = disabled;
    button.innerHTML = `${icons[action]}<span>${label}</span>`;
    button.setAttribute("aria-label", label);
    button.title = label;
    return button;
  }

  function createServiceCard(service) {
    const card = document.createElement("article");
    const statusKey = statusClass(service.status);
    const isBusy = state.busyServices.has(service.name);
    const active = ["RUNNING", "STARTING", "STOPPING"].includes(service.status);
    const transitioning = ["STARTING", "STOPPING"].includes(service.status);
    card.className = `service-card${state.selectedService === service.name ? " selected" : ""}`;
    card.tabIndex = 0;
    card.dataset.service = service.name;
    card.setAttribute("aria-label", `${service.name}，${statusLabel(service.status)}`);

    const head = document.createElement("div");
    head.className = "service-card-head";
    const nameRow = document.createElement("div");
    nameRow.className = "service-name-row";
    const dot = document.createElement("span");
    dot.className = `status-indicator status-${statusKey}`;
    dot.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "service-name";
    name.textContent = service.name;
    name.title = service.name;
    nameRow.append(dot, name);
    const badge = document.createElement("span");
    badge.className = `state-badge state-${statusKey}`;
    badge.textContent = isBusy ? "处理中" : statusLabel(service.status);
    head.append(nameRow, badge);

    const command = document.createElement("div");
    command.className = "service-command";
    command.textContent = service.command || "未配置启动命令";
    command.title = service.command;
    const cwd = document.createElement("div");
    cwd.className = "service-cwd";
    cwd.textContent = service.cwd || "未配置工作目录";
    cwd.title = service.cwd;

    const metrics = document.createElement("div");
    metrics.className = "service-metrics";
    const memory = Number.isFinite(service.memoryBytes)
      ? formatBytes(service.memoryBytes)
      : formatPercent(service.memoryPercent);
    metrics.append(
      metricElement("PID", Number.isFinite(service.pid) ? String(service.pid) : "—"),
      metricElement("运行时长", formatDuration(currentUptime(service)), service.name),
      metricElement("CPU", formatPercent(service.cpuPercent)),
      metricElement("内存", memory),
    );

    const actions = document.createElement("div");
    actions.className = "service-actions";
    const lifecycleActions = document.createElement("div");
    lifecycleActions.className = "service-lifecycle-actions";
    lifecycleActions.append(
      actionButton("start", "启动", isBusy || ["RUNNING", "STARTING", "STOPPING"].includes(service.status)),
      actionButton("stop", "停止", isBusy || !active || service.status === "STOPPING"),
      actionButton("restart", "重启", isBusy || service.status === "STARTING" || service.status === "STOPPING"),
    );
    const definitionActions = document.createElement("div");
    definitionActions.className = "service-definition-actions";
    definitionActions.append(
      actionButton("edit", "编辑服务", isBusy || transitioning, { iconOnly: true }),
      actionButton("copy", "复制服务", isBusy, { iconOnly: true }),
      actionButton("delete", "删除服务", isBusy, { iconOnly: true }),
    );
    actions.append(lifecycleActions, definitionActions);

    card.append(head, command, cwd, metrics, actions);
    return card;
  }

  function renderServiceList() {
    const services = [...state.services.values()].sort((a, b) => a.name.localeCompare(b.name));
    const filter = state.filter.trim().toLocaleLowerCase();
    const visible = filter
      ? services.filter((service) => `${service.name} ${service.command} ${service.cwd}`.toLocaleLowerCase().includes(filter))
      : services;
    const running = services.filter((service) => service.status === "RUNNING").length;

    elements.serviceCount.textContent = String(services.length);
    elements.runningSummary.textContent = services.length
      ? `${running} 个运行中 · ${services.length - running} 个未运行`
      : "还没有配置服务";
    elements.serviceList.replaceChildren();
    elements.serviceList.setAttribute("aria-busy", "false");

    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = filter
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg><strong>没有匹配的服务</strong><span>调整筛选条件后重试</span>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M8 9h8M8 13h5"/></svg><strong>暂无服务</strong><span>点击“添加服务”创建第一个本地进程启动项</span>';
      elements.serviceList.append(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    visible.forEach((service) => fragment.append(createServiceCard(service)));
    elements.serviceList.append(fragment);
  }

  function portCell(label, value, className = "") {
    const cell = document.createElement("td");
    cell.dataset.label = label;
    if (className) cell.className = className;
    cell.textContent = value;
    cell.title = value;
    return cell;
  }

  function createPortRow(item) {
    const row = document.createElement("tr");
    const protocol = portCell("协议", "", "port-protocol-cell");
    const protocolBadge = document.createElement("span");
    protocolBadge.className = "port-protocol";
    protocolBadge.textContent = item.protocol;
    protocol.append(protocolBadge);

    const address = portCell("监听地址", item.localAddress || "*", "port-address");
    const port = portCell("端口", String(item.port), "port-number");
    const pid = portCell("PID", Number.isInteger(item.pid) ? String(item.pid) : "—", "port-pid");
    const process = portCell("进程", item.processName, "port-process");
    const command = portCell("命令", item.command || "—", "port-command");
    const username = portCell("用户", item.username, "port-user");
    const actions = document.createElement("td");
    actions.dataset.label = "操作";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "terminate-process-button";
    button.dataset.pid = Number.isInteger(item.pid) ? String(item.pid) : "";
    button.dataset.port = String(item.port);
    button.disabled = !Number.isInteger(item.pid) || state.busyPids.has(item.pid);
    button.innerHTML = `${icons.terminate}<span>${state.busyPids.has(item.pid) ? "终止中…" : "终止进程"}</span>`;
    button.setAttribute(
      "aria-label",
      Number.isInteger(item.pid)
        ? `终止进程 ${item.processName}，PID ${item.pid}，端口 ${item.port}`
        : `端口 ${item.port} 的进程信息不可用`,
    );
    actions.append(button);
    row.append(protocol, address, port, pid, process, command, username, actions);
    return row;
  }

  function renderPortTable() {
    const ports = state.ports;
    const processCount = new Set(ports.map((item) => item.pid).filter(Number.isInteger)).size;
    elements.portCount.textContent = String(ports.length);
    elements.portsSummary.textContent = state.portFilter
      ? ports.length
        ? `端口 ${state.portFilter}：${ports.length} 条监听记录，涉及 ${processCount} 个进程`
        : `端口 ${state.portFilter} 当前没有监听进程`
      : `${ports.length} 条监听记录 · ${processCount} 个进程`;
    elements.clearPortFilterButton.disabled = state.portFilter === null;
    elements.portTableWrap.setAttribute("aria-busy", "false");
    elements.portTableBody.replaceChildren();

    if (!ports.length) {
      const row = document.createElement("tr");
      row.className = "port-placeholder-row";
      const cell = document.createElement("td");
      cell.colSpan = 8;
      const empty = document.createElement("div");
      empty.className = "port-empty-state";
      empty.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7V3M16 7V3M6 7h12v4a6 6 0 0 1-6 6v4M9 11h6"/></svg>';
      const title = document.createElement("strong");
      title.textContent = state.portFilter ? "该端口未被占用" : "没有发现监听端口";
      const detail = document.createElement("span");
      detail.textContent = state.portFilter ? "清除筛选条件可查看全部监听记录" : "点击刷新后重新扫描";
      empty.append(title, detail);
      cell.append(empty);
      row.append(cell);
      elements.portTableBody.append(row);
      return;
    }

    const fragment = document.createDocumentFragment();
    ports.forEach((item) => fragment.append(createPortRow(item)));
    elements.portTableBody.append(fragment);
  }

  function renderPortLoadError(message) {
    elements.portsSummary.textContent = "端口扫描失败";
    elements.portTableWrap.setAttribute("aria-busy", "false");
    const row = document.createElement("tr");
    row.className = "port-placeholder-row";
    const cell = document.createElement("td");
    cell.colSpan = 8;
    const empty = document.createElement("div");
    empty.className = "port-empty-state";
    empty.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5M12 17h.01"/><path d="M10.3 4.5 3.4 17a2 2 0 0 0 1.75 3h13.7a2 2 0 0 0 1.75-3L13.7 4.5a2 2 0 0 0-3.4 0Z"/></svg>';
    const title = document.createElement("strong");
    title.textContent = "端口扫描失败";
    const detail = document.createElement("span");
    detail.textContent = message;
    empty.append(title, detail);
    cell.append(empty);
    row.append(cell);
    elements.portTableBody.replaceChildren(row);
  }

  async function loadPorts({ silent = false } = {}) {
    if (state.loadingPorts) return;
    state.loadingPorts = true;
    elements.portTableWrap.setAttribute("aria-busy", "true");
    try {
      const query = state.portFilter === null ? "" : `?port=${encodeURIComponent(state.portFilter)}`;
      const payload = await apiRequest(`/api/ports${query}`);
      state.ports = extractPorts(payload);
      state.portsLoaded = true;
      renderPortTable();
      setConnectionState(elements.apiStatus, "ok", "API 正常");
    } catch (error) {
      if (!silent) showToast("读取端口失败", error.message, "error");
      if (!state.portsLoaded) renderPortLoadError(error.message);
    } finally {
      state.loadingPorts = false;
    }
  }

  async function terminateProcess(item) {
    if (!Number.isInteger(item.pid) || state.busyPids.has(item.pid)) return;
    const command = item.command ? `\n命令：${item.command}` : "";
    const confirmed = window.confirm(
      `确定终止进程“${item.processName}”吗？\nPID：${item.pid}\n监听：${item.localAddress || "*"}:${item.port}${command}\n\n该进程占用的其他端口也会被释放。`,
    );
    if (!confirmed) return;

    state.busyPids.add(item.pid);
    renderPortTable();
    try {
      const requestTermination = (force) => apiRequest(`/api/processes/${item.pid}/terminate`, {
        method: "POST",
        body: { expected_port: item.port, force, timeout: 3 },
      });

      let payload;
      try {
        payload = await requestTermination(false);
      } catch (error) {
        if (!(error instanceof ApiError) || ![408, 409, 504].includes(error.status)) throw error;
        const forceConfirmed = window.confirm(
          `进程 PID ${item.pid} 未在 3 秒内退出。\n\n是否强制结束该进程？未保存的数据可能丢失。`,
        );
        if (!forceConfirmed) {
          showToast("已取消强制结束", `PID ${item.pid} 仍在运行`, "info");
          return;
        }
        payload = await requestTermination(true);
      }

      let result = payload?.result ?? payload ?? {};
      if (result.terminated === false) {
        const forceConfirmed = window.confirm(
          `进程 PID ${item.pid} 未在 3 秒内退出。\n\n是否强制结束该进程？未保存的数据可能丢失。`,
        );
        if (!forceConfirmed) {
          showToast("已取消强制结束", `PID ${item.pid} 仍在运行`, "info");
          return;
        }
        const forcePayload = await requestTermination(true);
        result = forcePayload?.result ?? forcePayload ?? {};
      }

      const action = String(result.action || "terminate").toUpperCase();
      const detail = result.terminated === false
        ? `PID ${item.pid} 未退出，请刷新状态后重试`
        : `PID ${item.pid} 已退出（${action}，端口 ${result.expected_port ?? item.port}）`;
      showToast(result.terminated === false ? "进程仍在运行" : "进程已终止", detail, result.terminated === false ? "error" : "success");
    } catch (error) {
      showToast("终止进程失败", error.message, "error");
    } finally {
      state.busyPids.delete(item.pid);
      await loadPorts({ silent: true });
      renderPortTable();
    }
  }

  function setActiveView(view, { updateUrl = true, load = true } = {}) {
    const nextView = view === "ports" ? "ports" : "services";
    state.activeView = nextView;
    const showPorts = nextView === "ports";
    elements.servicesWorkspace.hidden = showPorts;
    elements.portsWorkspace.hidden = !showPorts;
    elements.servicesViewButton.classList.toggle("is-active", !showPorts);
    elements.portsViewButton.classList.toggle("is-active", showPorts);
    elements.servicesViewButton.setAttribute("aria-selected", String(!showPorts));
    elements.portsViewButton.setAttribute("aria-selected", String(showPorts));
    elements.openAddButton.hidden = showPorts;
    elements.refreshButton.setAttribute("aria-label", showPorts ? "刷新端口列表" : "刷新服务列表");
    if (showPorts) {
      setServicesDrawer(false, { restoreFocus: false });
      if (load && !state.portsLoaded) loadPorts();
    } else {
      scheduleTerminalFit();
    }
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.hash = showPorts ? "ports" : "";
      window.history.replaceState(null, "", url);
    }
  }

  function renderSelectedService() {
    const service = state.selectedService ? state.services.get(state.selectedService) : null;
    const statusKey = statusClass(service?.status);
    elements.consoleTitle.textContent = service?.name || "实时日志";
    elements.selectedStatus.textContent = service ? statusLabel(service.status) : "未选择";
    elements.selectedStatus.className = `state-badge state-${statusKey}`;
    elements.selectedStatusDot.className = `status-indicator status-${statusKey}`;
    elements.selectedDescription.textContent = service?.command || "从左侧选择一个服务查看输出";
    elements.selectedDescription.title = service?.command || "";
    elements.searchLogsButton.disabled = !service || !terminal;
    elements.clearLogsButton.disabled = !service;
    elements.mobileSelectedService.textContent = service?.name || "选择服务";
    elements.mobileSelectedStatusDot.className = `status-indicator status-${statusKey}`;
    elements.mobileServicesButton.setAttribute(
      "aria-label",
      service ? `当前服务 ${service.name}，打开服务列表` : "打开服务列表",
    );
  }

  async function loadServices({ silent = false } = {}) {
    try {
      const payload = await apiRequest("/api/services");
      const services = extractServices(payload);
      const previousSelectedService = state.selectedService;
      state.services = new Map(services.map((service) => [service.name, service]));

      if (state.selectedService && !state.services.has(state.selectedService)) {
        state.selectedService = null;
      }
      if (!state.selectedService && services.length) {
        state.selectedService = services[0].name;
      }

      renderServiceList();
      renderSelectedService();
      if (state.selectedService && !state.loadedLogs.has(state.selectedService)) {
        await loadLogs(state.selectedService);
      } else if (state.selectedService !== previousSelectedService) {
        renderLogs();
      }
      setConnectionState(elements.apiStatus, "ok", "API 正常");
    } catch (error) {
      setConnectionState(elements.apiStatus, "error", "API 异常");
      if (!silent) showToast("加载服务失败", error.message, "error");
      if (!state.services.size) renderLoadError(error.message);
    }
  }

  function renderLoadError(message) {
    elements.serviceList.setAttribute("aria-busy", "false");
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.innerHTML = '<path d="M12 8v5M12 17h.01"/><path d="M10.3 4.5 3.4 17a2 2 0 0 0 1.75 3h13.7a2 2 0 0 0 1.75-3L13.7 4.5a2 2 0 0 0-3.4 0Z"/>';
    const strong = document.createElement("strong");
    strong.textContent = "服务列表加载失败";
    const detail = document.createElement("span");
    detail.textContent = message;
    empty.append(icon, strong, detail);
    elements.serviceList.replaceChildren(empty);
  }

  async function checkHealth() {
    try {
      const payload = await apiRequest("/api/health");
      const healthy = payload?.status === undefined || ["ok", "healthy"].includes(String(payload.status).toLowerCase());
      setConnectionState(elements.apiStatus, healthy ? "ok" : "error", healthy ? "API 正常" : "API 异常");
    } catch {
      setConnectionState(elements.apiStatus, "error", "API 异常");
    }
  }

  function extractLogs(payload) {
    const logs = Array.isArray(payload) ? payload : payload?.logs ?? payload?.data ?? [];
    return Array.isArray(logs) ? logs : [logs];
  }

  function normalizeLogEntry(entry) {
    if (typeof entry === "string" || typeof entry === "number") {
      return { timestamp: null, stream: "stdout", message: String(entry) };
    }
    const source = entry && typeof entry === "object" ? entry : {};
    return {
      timestamp: source.timestamp ?? source.time ?? source.created_at ?? null,
      stream: String(source.stream ?? source.channel ?? "stdout").toLowerCase(),
      message: String(source.message ?? source.line ?? source.text ?? ""),
    };
  }

  function logEntryKey(entry) {
    return `${entry.timestamp ?? ""}\u0000${entry.stream}\u0000${entry.message}`;
  }

  function mergeLogEntries(existing, incoming) {
    const seen = new Set();
    const merged = [];
    for (const entry of existing.concat(incoming)) {
      const key = logEntryKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
    merged.sort((left, right) => {
      const leftTime = Date.parse(left.timestamp || "");
      const rightTime = Date.parse(right.timestamp || "");
      if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
      return leftTime - rightTime;
    });
    return merged;
  }

  function setLogBuffer(serviceName, entries, replace = false, reconcile = false) {
    const normalized = entries.map(normalizeLogEntry);
    const existing = state.logBuffers.get(serviceName) || [];
    const combined = reconcile
      ? mergeLogEntries(existing, normalized)
      : (replace ? normalized : existing.concat(normalized));
    state.logBuffers.set(serviceName, combined.slice(-MAX_LOG_ENTRIES));
    state.logVersions.set(serviceName, (state.logVersions.get(serviceName) || 0) + 1);
  }

  async function loadLogs(serviceName, { force = false } = {}) {
    if (!serviceName || (!force && state.loadedLogs.has(serviceName))) return;
    const requestVersion = state.logVersions.get(serviceName) || 0;
    if (serviceName === state.selectedService) setTerminalPlaceholder("正在读取日志", "加载最近 500 条输出…");
    try {
      const payload = await apiRequest(`/api/services/${encodeURIComponent(serviceName)}/logs?tail=500`);
      const hasConcurrentLogs = (state.logVersions.get(serviceName) || 0) !== requestVersion;
      setLogBuffer(serviceName, extractLogs(payload), !hasConcurrentLogs, hasConcurrentLogs);
      state.loadedLogs.add(serviceName);
      if (serviceName === state.selectedService) renderLogs();
    } catch (error) {
      if (serviceName === state.selectedService) {
        setTerminalPlaceholder("日志加载失败", error.message);
        showToast("读取日志失败", error.message, "error");
      }
    }
  }

  function formatLogTime(timestamp) {
    if (!timestamp) return "--:--:--.---";
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return String(timestamp).slice(0, 12);
    const base = new Intl.DateTimeFormat("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
    return `${base}.${String(date.getMilliseconds()).padStart(3, "0")}`;
  }

  function setTerminalPlaceholder(title, detail) {
    elements.terminalPlaceholder.hidden = false;
    elements.terminalPlaceholder.querySelector("strong").textContent = title;
    elements.terminalPlaceholder.querySelector("span").textContent = detail;
  }

  function sanitizeTerminalMessage(message) {
    return String(message)
      // OSC/DCS/APC/PM/SOS 可改标题、链接或剪贴板；只读日志视图不执行这些控制序列。
      .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
      .replace(/\u001b[P^_X][\s\S]*?\u001b\\/g, "")
      // CSI 仅保留 SGR（颜色和字形），过滤清屏、光标移动等显示控制。
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, (sequence) => (
        /^\u001b\[[0-9;:]*m$/.test(sequence) ? sequence : ""
      ))
      .replace(/\u001b\][^\r\n]*/g, "")
      .replace(/\u001b(?!\[[0-9;:]*m)/g, "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, "")
      .replace(/\r(?!\n)/g, "\n");
  }

  function formatTerminalEntry(entry) {
    const timestamp = formatLogTime(entry.timestamp).replace(/[\u0000-\u001f\u007f]/g, "");
    const streamName = String(entry.stream || "stdout")
      .replace(/[^a-z0-9_-]/gi, "")
      .slice(0, 8)
      .toUpperCase() || "STDOUT";
    const paddedStream = streamName.padEnd(8, " ");
    const streamColor = streamName === "STDERR" ? "\u001b[31m" : "\u001b[90m";
    const message = sanitizeTerminalMessage(entry.message);
    return `\u001b[90m${timestamp}\u001b[0m ${streamColor}${paddedStream}\u001b[0m ${message}\u001b[0m\r\n`;
  }

  function formatTerminalEntries(entries) {
    return entries.map(formatTerminalEntry).join("");
  }

  function currentTerminalSnapshot() {
    if (!state.selectedService) {
      return {
        entries: [],
        placeholder: ["等待选择服务", "日志会通过 WebSocket 实时显示在这里"],
      };
    }
    const entries = state.logBuffers.get(state.selectedService) || [];
    return {
      entries,
      placeholder: entries.length
        ? null
        : ["暂无日志", "服务启动后的标准输出和错误输出会显示在这里"],
    };
  }

  function finishTerminalReplay(revision, serviceName) {
    if (revision !== terminalReplayRevision) {
      terminalPendingEntries = [];
      drainTerminalReplay();
      return;
    }
    const pendingEntries = terminalPendingEntries;
    terminalPendingEntries = [];
    terminalReplayActive = false;
    terminalReplayService = null;

    const finish = () => {
      scrollTerminalToBottom();
      if (!elements.terminalSearch.hidden && elements.terminalSearchInput.value) {
        runTerminalSearch(true, true);
      }
    };
    if (state.selectedService === serviceName && pendingEntries.length) {
      terminal.write(formatTerminalEntries(pendingEntries), finish);
    } else {
      finish();
    }
  }

  function drainTerminalReplay() {
    if (!terminal) {
      terminalReplayActive = false;
      return;
    }
    const revision = terminalReplayRevision;
    const serviceName = state.selectedService;
    const snapshot = currentTerminalSnapshot();
    terminalReplayService = serviceName;
    terminalPendingEntries = [];
    if (snapshot.placeholder) setTerminalPlaceholder(...snapshot.placeholder);
    else elements.terminalPlaceholder.hidden = true;

    // 通过终端输入队列执行 RIS，再写入快照；这样不会和正在排队的实时 write 串台。
    terminal.write(`\u001bc${formatTerminalEntries(snapshot.entries)}`, () => {
      finishTerminalReplay(revision, serviceName);
    });
  }

  function requestTerminalReplay() {
    terminalReplayRevision += 1;
    terminalPendingEntries = [];
    if (!terminal || terminalReplayActive) return;
    terminalReplayActive = true;
    drainTerminalReplay();
  }

  function renderLogs() {
    requestTerminalReplay();
  }

  function appendVisibleLogs(entries) {
    if (!terminal || !entries.length) return;
    elements.terminalPlaceholder.hidden = true;
    if (terminalReplayActive) {
      if (terminalReplayService === state.selectedService) {
        terminalPendingEntries.push(...entries);
        terminalPendingEntries = terminalPendingEntries.slice(-MAX_LOG_ENTRIES);
      }
      return;
    }
    terminal.write(formatTerminalEntries(entries), scrollTerminalToBottom);
  }

  function scrollTerminalToBottom() {
    if (state.autoScroll && terminal && elements.terminalSearch.hidden) terminal.scrollToBottom();
  }

  function clearTerminalSearch() {
    elements.terminalSearchStatus.textContent = "";
    elements.terminalSearchInput.removeAttribute("aria-invalid");
    searchAddon?.clearDecorations?.();
  }

  function runTerminalSearch(forward = true, incremental = false) {
    if (!searchAddon) return false;
    const query = elements.terminalSearchInput.value;
    if (!query) {
      clearTerminalSearch();
      return false;
    }
    const options = {
      caseSensitive: false,
      incremental,
      regex: false,
      wholeWord: false,
    };
    const found = forward
      ? searchAddon.findNext(query, options)
      : searchAddon.findPrevious(query, options);
    elements.terminalSearchStatus.textContent = found ? "已定位" : "无匹配";
    elements.terminalSearchInput.toggleAttribute("aria-invalid", !found);
    return found;
  }

  function setTerminalSearch(open) {
    const shouldOpen = Boolean(open && state.selectedService && searchAddon);
    elements.terminalSearch.hidden = !shouldOpen;
    elements.searchLogsButton.setAttribute("aria-expanded", String(shouldOpen));
    if (shouldOpen) {
      window.setTimeout(() => {
        elements.terminalSearchInput.focus();
        elements.terminalSearchInput.select();
        if (elements.terminalSearchInput.value) runTerminalSearch(true, true);
      }, 0);
    } else {
      clearTerminalSearch();
      terminal?.focus();
      scrollTerminalToBottom();
    }
    scheduleTerminalFit();
  }

  async function selectService(serviceName) {
    if (!state.services.has(serviceName)) return;
    state.selectedService = serviceName;
    renderServiceList();
    renderSelectedService();
    if (window.matchMedia("(max-width: 767px)").matches) setServicesDrawer(false);
    if (state.loadedLogs.has(serviceName)) renderLogs();
    else await loadLogs(serviceName);
  }

  function setServicesDrawer(open, { restoreFocus = true } = {}) {
    const mobile = window.matchMedia("(max-width: 767px)").matches;
    const shouldOpen = Boolean(open && mobile);
    state.servicesDrawerOpen = shouldOpen;
    document.body.classList.toggle("services-drawer-open", shouldOpen);
    elements.mobileServicesButton.setAttribute("aria-expanded", String(shouldOpen));
    elements.servicesPanel.setAttribute("aria-hidden", mobile && !shouldOpen ? "true" : "false");

    document.querySelector(".topbar").inert = shouldOpen;
    document.querySelector(".console-panel").inert = shouldOpen;
    elements.mobileServicesButton.inert = shouldOpen;

    if (shouldOpen) {
      window.setTimeout(() => elements.closeServicesButton.focus(), 0);
    } else if (restoreFocus && mobile) {
      window.setTimeout(() => elements.mobileServicesButton.focus(), 0);
    }
    if (!shouldOpen) scheduleTerminalFit();
  }

  function mergeStatusEvent(serviceName, data) {
    const current = state.services.get(serviceName);
    const update = typeof data === "string" ? { status: data } : data?.service ?? data ?? {};
    const raw = { ...(current?.raw || current || {}), ...(typeof update === "object" ? update : {}), name: serviceName };
    state.services.set(serviceName, normalizeService(raw, serviceName));
    renderServiceList();
    if (state.selectedService === serviceName) renderSelectedService();
  }

  function websocketUrl() {
    const url = new URL("/ws/events", window.location.href);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    if (token) url.searchParams.set("token", token);
    return url.toString();
  }

  function connectWebSocket() {
    clearTimeout(state.reconnectTimer);
    if (state.socket && state.socket.readyState < WebSocket.CLOSING) state.socket.close();
    setConnectionState(elements.socketStatus, "pending", "实时连接中");

    const socket = new WebSocket(websocketUrl());
    state.socket = socket;

    socket.addEventListener("open", () => {
      state.reconnectAttempt = 0;
      setConnectionState(elements.socketStatus, "ok", "实时已连接");
      loadServices({ silent: true });
      if (state.selectedService) loadLogs(state.selectedService, { force: true });
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const serviceName = String(message.service || "");
      if (!serviceName) return;

      if (message.type === "status") {
        mergeStatusEvent(serviceName, message.data);
      } else if (message.type === "log") {
        const rawEntries = Array.isArray(message.data)
          ? message.data
          : Array.isArray(message.data?.logs) ? message.data.logs : [message.data];
        const normalized = rawEntries.map(normalizeLogEntry);
        setLogBuffer(serviceName, rawEntries);
        state.loadedLogs.add(serviceName);
        if (state.selectedService === serviceName) appendVisibleLogs(normalized);
      }
    });

    socket.addEventListener("close", () => {
      if (state.socket !== socket) return;
      const attempt = state.reconnectAttempt++;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
      setConnectionState(elements.socketStatus, "error", `实时重连 ${Math.round(delay / 1000)}s`);
      state.reconnectTimer = window.setTimeout(connectWebSocket, delay + Math.random() * 400);
    });

    socket.addEventListener("error", () => socket.close());
  }

  async function runServiceAction(serviceName, action) {
    if (state.busyServices.has(serviceName)) return;
    if (action === "delete") {
      const confirmed = window.confirm(`确定删除服务“${serviceName}”吗？\n该操作会删除持久化的服务定义。`);
      if (!confirmed) return;
    }

    state.busyServices.add(serviceName);
    renderServiceList();
    try {
      if (action === "delete") {
        await apiRequest(`/api/services/${encodeURIComponent(serviceName)}`, { method: "DELETE" });
        state.logBuffers.delete(serviceName);
        state.logVersions.delete(serviceName);
        state.loadedLogs.delete(serviceName);
        if (state.selectedService === serviceName) state.selectedService = null;
        showToast("服务已删除", serviceName, "success");
      } else {
        await apiRequest(`/api/services/${encodeURIComponent(serviceName)}/${action}`, { method: "POST" });
        const actionLabels = { start: "启动", stop: "停止", restart: "重启" };
        showToast(`已发送${actionLabels[action]}指令`, serviceName, "success");
      }
      await loadServices({ silent: true });
    } catch (error) {
      const labels = { start: "启动", stop: "停止", restart: "重启", delete: "删除" };
      showToast(`${labels[action]}服务失败`, error.message, "error");
    } finally {
      state.busyServices.delete(serviceName);
      renderServiceList();
    }
  }

  function parseEnvironment(value) {
    const text = value.trim();
    if (!text) return {};
    if (text.startsWith("{")) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(`环境变量 JSON 格式错误：${error.message}`);
      }
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("环境变量 JSON 必须是对象");
      }
      return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]));
    }

    const environment = {};
    for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator <= 0) throw new Error(`环境变量第 ${index + 1} 行应为 KEY=VALUE`);
      const key = line.slice(0, separator).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`环境变量名“${key}”不合法`);
      environment[key] = line.slice(separator + 1);
    }
    return environment;
  }

  function serializeEnvironment(environment) {
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) return "";
    return Object.keys(environment).length ? JSON.stringify(environment, null, 2) : "";
  }

  function nextCopyName(sourceName) {
    for (let index = 1; ; index += 1) {
      const suffix = index === 1 ? "-copy" : `-copy-${index}`;
      const base = sourceName.slice(0, Math.max(1, 80 - suffix.length));
      const candidate = `${base}${suffix}`;
      if (!state.services.has(candidate)) return candidate;
    }
  }

  function resetServiceForm() {
    state.serviceFormMode = "create";
    state.editingServiceName = null;
    elements.serviceForm.reset();
    elements.serviceForm.elements.stop_timeout.value = "10";
    elements.serviceNameInput.readOnly = false;
    elements.serviceNameInput.removeAttribute("aria-readonly");
    elements.serviceNameInput.removeAttribute("aria-invalid");
    elements.serviceNameHelp.textContent = "仅使用字母、数字、点、下划线和连字符";
    elements.serviceDialogEyebrow.textContent = "新建进程定义";
    elements.serviceDialogTitle.textContent = "添加服务";
    elements.serviceDialogDescription.textContent = "命令会在指定工作目录中直接启动，不经过容器。";
    elements.submitServiceButton.disabled = false;
    elements.submitServiceButton.querySelector(".button-label").textContent = "创建服务";
  }

  function openServiceForm(mode, serviceName = null) {
    const service = serviceName ? state.services.get(serviceName) : null;
    if (mode !== "create" && !service) {
      showToast("服务配置不可用", "请刷新服务列表后重试", "error");
      return;
    }

    resetServiceForm();
    state.serviceFormMode = mode;
    state.editingServiceName = mode === "edit" ? service.name : null;

    if (mode === "edit") {
      elements.serviceDialogEyebrow.textContent = "修改进程定义";
      elements.serviceDialogTitle.textContent = "编辑服务";
      elements.serviceDialogDescription.textContent = service.status === "RUNNING"
        ? "当前进程不会中断；启动命令、目录和环境将在下次重启后生效。"
        : "保存完整服务定义，新的启动参数会在下次启动时生效。";
      elements.submitServiceButton.querySelector(".button-label").textContent = "保存修改";
      elements.serviceNameInput.readOnly = true;
      elements.serviceNameInput.setAttribute("aria-readonly", "true");
      elements.serviceNameHelp.textContent = "服务名称不可直接修改；需要新名称时请使用复制";
    } else if (mode === "copy") {
      elements.serviceDialogEyebrow.textContent = "复制进程定义";
      elements.serviceDialogTitle.textContent = "复制服务";
      elements.serviceDialogDescription.textContent = "已复制启动参数；副本默认关闭自动启动，以避免端口冲突。";
      elements.submitServiceButton.querySelector(".button-label").textContent = "创建副本";
    }

    if (service) {
      elements.serviceForm.elements.name.value = mode === "copy" ? nextCopyName(service.name) : service.name;
      elements.serviceForm.elements.command.value = service.command;
      elements.serviceForm.elements.cwd.value = service.cwd;
      elements.serviceForm.elements.env.value = serializeEnvironment(service.env);
      elements.serviceForm.elements.stop_timeout.value = String(service.stopTimeout);
      elements.serviceForm.elements.auto_start.checked = mode === "edit" ? service.autoStart : false;
    }

    elements.serviceDialog.showModal();
    const initialField = mode === "edit" ? elements.serviceForm.elements.command : elements.serviceNameInput;
    window.setTimeout(() => {
      initialField.focus();
      if (mode === "copy") initialField.select();
    }, 0);
  }

  async function submitService(event) {
    event.preventDefault();
    elements.serviceNameInput.removeAttribute("aria-invalid");
    if (!elements.serviceForm.reportValidity()) return;
    const form = new FormData(elements.serviceForm);
    let environment;
    try {
      environment = parseEnvironment(String(form.get("env") || ""));
    } catch (error) {
      showToast("环境变量格式错误", error.message, "error");
      return;
    }

    const serviceName = String(form.get("name") || "").trim();
    const definition = {
      command: String(form.get("command") || "").trim(),
      cwd: String(form.get("cwd") || "").trim(),
      env: environment,
      auto_start: form.get("auto_start") === "on",
      stop_timeout: Number(form.get("stop_timeout")),
    };

    const mode = state.serviceFormMode;
    const editingName = state.editingServiceName;
    const selectedName = mode === "edit" ? editingName : serviceName;
    const runningBeforeEdit = mode === "edit" && state.services.get(editingName)?.status === "RUNNING";
    const labels = mode === "edit"
      ? { pending: "保存中…", ready: "保存修改", success: "服务配置已保存", failure: "保存服务失败" }
      : mode === "copy"
        ? { pending: "复制中…", ready: "创建副本", success: "服务副本已创建", failure: "复制服务失败" }
        : { pending: "创建中…", ready: "创建服务", success: "服务已创建", failure: "创建服务失败" };

    elements.submitServiceButton.disabled = true;
    elements.submitServiceButton.querySelector(".button-label").textContent = labels.pending;
    try {
      if (mode === "edit") {
        await apiRequest(`/api/services/${encodeURIComponent(editingName)}`, {
          method: "PUT",
          body: definition,
        });
      } else {
        await apiRequest("/api/services", {
          method: "POST",
          body: { name: serviceName, ...definition },
        });
      }
      elements.serviceDialog.close();
      state.selectedService = selectedName;
      const toastDetail = runningBeforeEdit
        ? `${selectedName} · 当前进程未中断，重启后应用新启动参数`
        : selectedName;
      showToast(labels.success, toastDetail, "success");
      await loadServices({ silent: true });
    } catch (error) {
      if (mode !== "edit" && error.status === 400 && /already exists|已存在/i.test(error.message)) {
        elements.serviceNameInput.setAttribute("aria-invalid", "true");
        elements.serviceNameInput.focus();
        elements.serviceNameInput.select();
      }
      showToast(labels.failure, error.message, "error");
    } finally {
      elements.submitServiceButton.disabled = false;
      if (elements.serviceDialog.open) {
        elements.submitServiceButton.querySelector(".button-label").textContent = labels.ready;
      }
    }
  }

  function showToast(title, message, kind = "info") {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.dataset.kind = kind;
    toast.setAttribute("role", kind === "error" ? "alert" : "status");
    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.textContent = kind === "error" ? "!" : kind === "success" ? "✓" : "i";
    const content = document.createElement("div");
    content.className = "toast-content";
    const heading = document.createElement("strong");
    heading.textContent = title;
    const detail = document.createElement("span");
    detail.textContent = message || "";
    content.append(heading, detail);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast-close";
    close.setAttribute("aria-label", "关闭通知");
    close.textContent = "×";
    close.addEventListener("click", () => toast.remove());
    toast.append(icon, content, close);
    elements.toastRegion.append(toast);
    window.setTimeout(() => toast.remove(), kind === "error" ? 8000 : 4500);
  }

  function updateUptimeLabels() {
    document.querySelectorAll("[data-uptime-service]").forEach((element) => {
      const service = state.services.get(element.dataset.uptimeService);
      if (service) element.textContent = formatDuration(currentUptime(service));
    });
  }

  function bindEvents() {
    elements.refreshButton.addEventListener("click", async () => {
      elements.refreshButton.disabled = true;
      if (state.activeView === "ports") await Promise.all([loadPorts(), checkHealth()]);
      else await Promise.all([loadServices(), checkHealth()]);
      elements.refreshButton.disabled = false;
    });
    elements.servicesViewButton.addEventListener("click", () => setActiveView("services"));
    elements.portsViewButton.addEventListener("click", () => setActiveView("ports"));
    elements.portFilterForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!elements.portFilterInput.reportValidity()) return;
      const value = elements.portFilterInput.value.trim();
      state.portFilter = value ? Number(value) : null;
      state.portsLoaded = false;
      await loadPorts();
    });
    elements.clearPortFilterButton.addEventListener("click", async () => {
      elements.portFilterInput.value = "";
      state.portFilter = null;
      state.portsLoaded = false;
      await loadPorts();
      elements.portFilterInput.focus();
    });
    elements.portTableBody.addEventListener("click", (event) => {
      const button = event.target.closest(".terminate-process-button");
      if (!button) return;
      const pid = Number(button.dataset.pid);
      const port = Number(button.dataset.port);
      const item = state.ports.find((candidate) => candidate.pid === pid && candidate.port === port);
      if (item) terminateProcess(item);
    });
    elements.openAddButton.addEventListener("click", () => openServiceForm("create"));
    elements.closeServiceDialogButton.addEventListener("click", () => elements.serviceDialog.close());
    elements.cancelServiceDialogButton.addEventListener("click", () => elements.serviceDialog.close());
    elements.serviceDialog.addEventListener("click", (event) => {
      if (event.target === elements.serviceDialog) elements.serviceDialog.close();
    });
    elements.serviceDialog.addEventListener("close", resetServiceForm);
    elements.serviceForm.addEventListener("submit", submitService);
    elements.serviceNameInput.addEventListener("input", () => {
      elements.serviceNameInput.removeAttribute("aria-invalid");
    });
    elements.mobileServicesButton.addEventListener("click", () => setServicesDrawer(true));
    elements.mobileServicesBackdrop.addEventListener("click", () => setServicesDrawer(false));
    elements.closeServicesButton.addEventListener("click", () => setServicesDrawer(false));
    document.addEventListener("keydown", (event) => {
      const editableTarget = event.target?.closest?.("input, textarea, select, [contenteditable='true']");
      const shortcutAllowed = !editableTarget || elements.terminal.contains(editableTarget);
      if (
        event.key.toLowerCase() === "f"
        && (event.metaKey || event.ctrlKey)
        && state.activeView === "services"
        && state.selectedService
        && !elements.serviceDialog.open
        && shortcutAllowed
      ) {
        event.preventDefault();
        setTerminalSearch(true);
        return;
      }
      if (event.key === "Escape" && !elements.terminalSearch.hidden) {
        event.preventDefault();
        setTerminalSearch(false);
        return;
      }
      if (event.key === "Escape" && state.servicesDrawerOpen) setServicesDrawer(false);
    });
    window.matchMedia("(max-width: 767px)").addEventListener("change", () => {
      setServicesDrawer(false, { restoreFocus: false });
      scheduleTerminalFit();
    });
    window.addEventListener("resize", scheduleTerminalFit);
    elements.serviceSearch.addEventListener("input", () => {
      state.filter = elements.serviceSearch.value;
      renderServiceList();
    });
    elements.serviceList.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]");
      const card = event.target.closest("[data-service]");
      if (!card) return;
      if (action) {
        event.stopPropagation();
        if (["edit", "copy"].includes(action.dataset.action)) {
          openServiceForm(action.dataset.action, card.dataset.service);
        } else {
          runServiceAction(card.dataset.service, action.dataset.action);
        }
      } else {
        selectService(card.dataset.service);
      }
    });
    elements.serviceList.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key) || event.target.closest("button")) return;
      const card = event.target.closest("[data-service]");
      if (card) {
        event.preventDefault();
        selectService(card.dataset.service);
      }
    });
    elements.autoScrollToggle.checked = state.autoScroll;
    elements.autoScrollToggle.addEventListener("change", () => {
      state.autoScroll = elements.autoScrollToggle.checked;
      localStorage.setItem("service-console:auto-scroll", String(state.autoScroll));
      scrollTerminalToBottom();
    });
    elements.searchLogsButton.addEventListener("click", () => setTerminalSearch(true));
    elements.terminalSearchPrevious.addEventListener("click", () => runTerminalSearch(false));
    elements.terminalSearchNext.addEventListener("click", () => runTerminalSearch(true));
    elements.terminalSearchClose.addEventListener("click", () => setTerminalSearch(false));
    elements.terminalSearchInput.addEventListener("input", () => runTerminalSearch(true, true));
    elements.terminalSearchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setTerminalSearch(false);
      } else if (event.key === "Enter") {
        event.preventDefault();
        runTerminalSearch(!event.shiftKey);
      }
    });
    elements.clearLogsButton.addEventListener("click", () => {
      if (!state.selectedService) return;
      state.logBuffers.set(state.selectedService, []);
      state.logVersions.set(
        state.selectedService,
        (state.logVersions.get(state.selectedService) || 0) + 1,
      );
      renderLogs();
      showToast("当前视图已清空", "服务端日志文件不会被删除", "info");
    });
  }

  async function initialize() {
    initializeTerminal();
    bindEvents();
    setServicesDrawer(false, { restoreFocus: false });
    setActiveView(state.activeView, { updateUrl: false, load: false });
    const initialLoads = [loadServices(), checkHealth()];
    if (state.activeView === "ports") initialLoads.push(loadPorts());
    await Promise.all(initialLoads);
    connectWebSocket();
    state.servicePollTimer = window.setInterval(() => loadServices({ silent: true }), SERVICE_POLL_INTERVAL);
    state.portPollTimer = window.setInterval(() => {
      if (state.activeView === "ports") loadPorts({ silent: true });
    }, PORT_POLL_INTERVAL);
    state.healthPollTimer = window.setInterval(checkHealth, HEALTH_POLL_INTERVAL);
    window.setInterval(updateUptimeLabels, 1000);
  }

  window.addEventListener("beforeunload", () => {
    clearTimeout(state.reconnectTimer);
    clearInterval(state.servicePollTimer);
    clearInterval(state.portPollTimer);
    clearInterval(state.healthPollTimer);
    if (terminalFitFrame !== null) window.cancelAnimationFrame(terminalFitFrame);
    terminalResizeObserver?.disconnect();
    terminal?.dispose();
    if (state.socket) state.socket.close();
  });

  initialize();
})();
