const $ = (id) => document.getElementById(id);
const history = [];
let timer = null;
let loadingMetrics = false;
let lastData = null;

function text(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function formatBytes(value, decimals = 1) {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(value)) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index ? decimals : 0)} ${units[index]}`;
}

function formatRate(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond)) return '—';
  const bits = bytesPerSecond * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gbps`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(2)} Mbps`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(1)} Kbps`;
  return `${bits.toFixed(0)} bps`;
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
}

function formatPing(value) {
  return Number.isFinite(value) ? `${Math.round(value)} ms` : 'aguardando';
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function createCell(row, primary, secondary = null) {
  const cell = document.createElement('td');
  const first = document.createElement('span');
  first.className = 'primary';
  first.textContent = primary;
  cell.append(first);
  if (secondary) {
    const second = document.createElement('span');
    second.className = 'secondary';
    second.textContent = secondary;
    cell.append(second);
  }
  row.append(cell);
  return cell;
}

function createBadges(cell, values) {
  cell.textContent = '';
  for (const value of values) {
    const badge = document.createElement('span');
    badge.className = `badge${value === 'transmitindo' ? ' green' : ''}`;
    badge.textContent = value;
    cell.append(badge);
  }
}

function resetRows(id) {
  const body = $(id);
  body.replaceChildren();
  return body;
}

function renderSummary(data) {
  const { summary, traffic } = data;
  text('metricUsers', summary.users.toLocaleString('pt-BR'));
  text('metricConnections', `${summary.connections} conexões WebSocket`);
  text('metricStreams', summary.streams.toLocaleString('pt-BR'));
  text('metricWatchers', `${summary.activeWatchers} espectadores ativos`);

  const totalRate = traffic.receivedBytesPerSecond + traffic.transmittedBytesPerSecond;
  text('metricBandwidth', formatRate(totalRate));
  text(
    'metricBandwidthSplit',
    `↓ ${formatRate(traffic.receivedBytesPerSecond)} · ↑ ${formatRate(traffic.transmittedBytesPerSecond)}`
  );
  text('metricPing', formatPing(summary.pingAverageMs));
  text('metricPingP95', `mediana ${formatPing(summary.pingMedianMs)} · p95 ${formatPing(summary.pingP95Ms)}`);
  text('metricGuilds', summary.guilds.toLocaleString('pt-BR'));
  text('metricRooms', `${summary.rooms} salas ativas`);
  text('metricTrafficTotal', formatBytes(traffic.receivedBytes + traffic.transmittedBytes));
  text('metricDropped', `${formatBytes(traffic.droppedBytes)} descartado`);
}

function renderSystem(data) {
  const { system, configuration } = data;
  const memory = system.memory;
  const usedHost = memory.hostTotalBytes - memory.hostFreeBytes;
  const disk = system.disk;

  text('processCpu', formatPercent(system.cpu.processPercent));
  text('hostCpu', formatPercent(system.cpu.hostPercent));
  text('processMemory', formatBytes(memory.process.rss));
  text('hostMemory', `${formatBytes(usedHost)} / ${formatBytes(memory.hostTotalBytes)}`);
  text('diskUsage', disk ? `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}` : '—');
  text('processUptime', formatDuration(system.processUptimeSeconds));
  text('hostPill', `${system.hostname} · ${system.platform}/${system.architecture} · Node ${system.nodeVersion}`);

  const container = system.container;
  const details = [
    ['Ambiente', configuration.environment],
    ['Origem pública', configuration.publicOrigin],
    ['Porta', String(configuration.port)],
    ['Discord Client ID', configuration.clientId ?? 'não configurado'],
    ['Bot Discord', configuration.botConfigured ? 'configurado' : 'não configurado'],
    ['Sistema', `${system.platform} ${system.release}`],
    ['CPU', `${system.cpu.logicalCores} lógicas · ${system.cpu.model}`],
    ['Load average', system.cpu.loadAverage.map((value) => value.toFixed(2)).join(' · ')],
    ['Rede do host', system.network.source === 'sistema' ? 'leitura do sistema' : 'indisponível neste SO'],
    ['Limite de CPU', Number.isFinite(container?.cpuLimitCores) ? `${container.cpuLimitCores} cores` : 'sem limite detectado'],
    ['Limite de memória', Number.isFinite(container?.memoryMax) ? formatBytes(container.memoryMax) : 'sem limite detectado'],
    ['PIDs no container', Number.isFinite(container?.pidsCurrent) ? `${container.pidsCurrent}${Number.isFinite(container.pidsMax) ? ` / ${container.pidsMax}` : ''}` : '—'],
  ];

  const list = $('environmentList');
  list.replaceChildren();
  for (const [label, value] of details) {
    const wrap = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    wrap.append(dt, dd);
    list.append(wrap);
  }

  const hostRate = system.network.receivedBytesPerSecond + system.network.transmittedBytesPerSecond;
  history.push({
    at: data.generatedAt,
    inbound: data.traffic.receivedBytesPerSecond,
    outbound: data.traffic.transmittedBytesPerSecond,
    host: Number.isFinite(hostRate) ? hostRate : null,
  });
  if (history.length > 60) history.shift();
  drawChart();
}

function renderGuilds(data) {
  const body = resetRows('guildRows');
  const rows = data.guilds;
  text('guildCount', String(rows.length));
  $('guildEmpty').hidden = rows.length > 0;
  $('guildRows').closest('.table-wrap').hidden = rows.length === 0;

  for (const guild of rows) {
    const row = document.createElement('tr');
    createCell(row, guild.name || 'Servidor sem nome', guild.id);
    createCell(row, String(guild.users));
    createCell(row, String(guild.connections));
    createCell(row, String(guild.rooms));
    createCell(row, String(guild.streams));
    createCell(
      row,
      formatRate(guild.traffic.receivedBytesPerSecond + guild.traffic.transmittedBytesPerSecond),
      `${formatBytes(guild.traffic.receivedBytes + guild.traffic.transmittedBytes)} total`
    );
    body.append(row);
  }
}

function renderRooms(data) {
  const body = resetRows('roomRows');
  const guildMap = new Map(data.guilds.map((guild) => [guild.id, guild.name || guild.id]));
  text('roomCount', String(data.rooms.length));
  $('roomEmpty').hidden = data.rooms.length > 0;
  $('roomRows').closest('.table-wrap').hidden = data.rooms.length === 0;

  for (const room of data.rooms) {
    const row = document.createElement('tr');
    createCell(row, room.name, room.id);
    createCell(
      row,
      room.guildId ? guildMap.get(room.guildId) : 'Web',
      room.channelId ? `canal ${room.channelId}` : room.isCall ? 'call' : 'lobby público'
    );
    createCell(row, String(room.users.length), `${room.connections} conexões`);
    createCell(row, String(room.streams.length));
    createCell(
      row,
      formatRate(room.traffic.receivedBytesPerSecond + room.traffic.transmittedBytesPerSecond),
      `${formatBytes(room.traffic.receivedBytes + room.traffic.transmittedBytes)} total`
    );
    createCell(row, room.droppedChunks.toLocaleString('pt-BR'), `${formatBytes(room.traffic.droppedBytes)}`);
    body.append(row);
  }
}

function renderStreams(data) {
  const body = resetRows('streamRows');
  text('streamCount', String(data.streams.length));
  $('streamEmpty').hidden = data.streams.length > 0;
  $('streamRows').closest('.table-wrap').hidden = data.streams.length === 0;

  for (const stream of data.streams) {
    const row = document.createElement('tr');
    createCell(row, stream.userName, stream.userId);
    createCell(row, stream.roomName, stream.guildName || stream.guildId || 'Web');
    const resolution = stream.width && stream.height ? `${stream.width}×${stream.height}` : 'aguardando config';
    createCell(row, resolution, [stream.codec, stream.audioCodec].filter(Boolean).join(' + ') || null);
    createCell(row, String(stream.watchers));
    createCell(row, formatRate(stream.traffic.receivedBytesPerSecond), `${formatBytes(stream.traffic.receivedBytes)} total`);
    createCell(row, formatRate(stream.traffic.transmittedBytesPerSecond), `${formatBytes(stream.traffic.transmittedBytes)} total`);
    createCell(row, formatBytes(stream.bufferedBytes), `${stream.droppedChunks} descartes`);
    body.append(row);
  }
}

function renderUsers(data) {
  const body = resetRows('userRows');
  const guildMap = new Map(data.guilds.map((guild) => [guild.id, guild.name || guild.id]));
  const roomMap = new Map(data.rooms.map((room) => [room.id, room.name]));
  text('userCount', String(data.users.length));
  $('userEmpty').hidden = data.users.length > 0;
  $('userRows').closest('.table-wrap').hidden = data.users.length === 0;

  for (const user of data.users) {
    const row = document.createElement('tr');
    createCell(row, user.name, user.id);
    const guildNames = user.guilds.map((id) => guildMap.get(id) || id);
    const roomNames = user.rooms.map((id) => roomMap.get(id) || id);
    createCell(row, guildNames.join(', ') || 'Web', roomNames.join(', '));
    const roleCell = createCell(row, '');
    createBadges(roleCell, [
      ...(user.broadcasting ? ['transmitindo'] : []),
      ...user.roles.map((role) => (role === 'viewer' ? 'espectador' : 'transmissor')),
    ]);
    createCell(row, String(user.connections), user.bufferedBytes ? `${formatBytes(user.bufferedBytes)} buffer` : null);
    createCell(row, formatPing(user.pingMs));
    createCell(row, formatDuration((data.generatedAt - user.connectedAt) / 1000));
    body.append(row);
  }
}

function drawChart() {
  const canvas = $('bandwidthChart');
  const box = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(box.width * ratio));
  canvas.height = Math.max(1, Math.round(box.height * ratio));
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);

  const width = box.width;
  const height = box.height;
  const pad = { left: 48, right: 8, top: 10, bottom: 22 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const values = history.flatMap((point) => [point.inbound, point.outbound, point.host ?? 0]);
  const max = Math.max(128 * 1024, ...values) * 1.12;

  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(255,255,255,.055)';
  ctx.fillStyle = '#666d80';
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (plotHeight * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(formatRate(max * (1 - i / 4)), pad.left - 7, y + 3);
  }

  const styles = getComputedStyle(document.documentElement);
  const series = [
    ['inbound', styles.getPropertyValue('--purple').trim()],
    ['outbound', styles.getPropertyValue('--green').trim()],
    ['host', styles.getPropertyValue('--blue').trim()],
  ];
  for (const [key, color] of series) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = key === 'host' ? 1.4 : 2;
    ctx.globalAlpha = key === 'host' ? .65 : .95;
    let started = false;
    history.forEach((point, index) => {
      const value = point[key];
      if (!Number.isFinite(value)) return;
      const x = pad.left + (index / Math.max(1, history.length - 1)) * plotWidth;
      const y = pad.top + plotHeight - (value / max) * plotHeight;
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
  ctx.fillText('agora', width - 34, height - 5);
  ctx.fillText('−2 min', pad.left, height - 5);
}

function render(data) {
  lastData = data;
  renderSummary(data);
  renderSystem(data);
  renderGuilds(data);
  renderRooms(data);
  renderStreams(data);
  renderUsers(data);
  text('lastUpdate', `atualizado ${new Date(data.generatedAt).toLocaleTimeString('pt-BR')}`);
  text('serverClock', `Servidor: ${new Date(data.generatedAt).toLocaleString('pt-BR')}`);
  $('liveStatus').className = 'live online';
  $('liveStatus').innerHTML = '<i></i> Ao vivo';
  $('errorBanner').hidden = true;
}

async function loadMetrics() {
  if (loadingMetrics) return;
  loadingMetrics = true;
  try {
    const response = await fetch('/api/admin/metrics', {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 401) {
      clearInterval(timer);
      location.reload();
      return;
    }
    if (!response.ok) throw new Error(`Servidor respondeu ${response.status}`);
    render(await response.json());
  } catch (error) {
    $('liveStatus').className = 'live error';
    $('liveStatus').innerHTML = '<i></i> Sem conexão';
    $('errorBanner').textContent = `Não foi possível atualizar: ${error.message}`;
    $('errorBanner').hidden = false;
  } finally {
    loadingMetrics = false;
  }
}

function loginErrorMessage() {
  const error = new URLSearchParams(location.search).get('error');
  const messages = {
    not_configured: 'O painel está desligado. Defina DISCORD_ADMIN_ID no arquivo .env e reinicie.',
    discord_not_configured: 'As credenciais OAuth do Discord ainda não estão configuradas.',
    forbidden: 'Esta conta Discord não está autorizada a acessar o painel.',
    troca_falhou: 'O Discord recusou o login. Confira o Client ID, Secret e Redirect URI.',
    perfil_falhou: 'Não foi possível confirmar sua identidade no Discord.',
    sem_codigo: 'O login foi cancelado antes de terminar.',
    interno: 'O servidor encontrou um erro durante o login.',
  };
  return error ? messages[error] || 'Não foi possível entrar no painel.' : null;
}

async function boot() {
  try {
    const response = await fetch('/api/admin/me', { cache: 'no-store' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      $('loading').hidden = true;
      $('login').hidden = false;
      const message = loginErrorMessage();
      if (message) text('loginMessage', message);
      if (data.configured === false) {
        text('loginMessage', 'O painel está desligado. Defina DISCORD_ADMIN_ID no arquivo .env e reinicie.');
        document.querySelector('.discord-button').hidden = true;
      }
      return;
    }

    $('loading').hidden = true;
    $('dashboard').hidden = false;
    await loadMetrics();
    timer = setInterval(loadMetrics, 2000);
  } catch {
    $('loading').hidden = true;
    $('login').hidden = false;
    text('loginMessage', 'O servidor não respondeu. Tente novamente em alguns segundos.');
  }
}

$('refresh').addEventListener('click', loadMetrics);
$('logout').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' }).catch(() => null);
  location.reload();
});
window.addEventListener('resize', () => lastData && drawChart());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadMetrics();
});

boot();
