// Noite na Vila — servidor (Node.js + Express + Socket.IO)
// Regras conforme o roteiro: apagão só para Assassino e Sabotador, turno do Detetive,
// funções completas por número de jogadores, bots com suspeita, e nenhum dado secreto
// enviado para quem não deve ver.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const PORT = process.env.PORT || 3000;
// Em um site público (Render ou PUBLICO=1), esconde os endereços da rede local e aplica limites mais rígidos.
const PUBLICO = !!(process.env.RENDER || process.env.PUBLICO);
const MAX_SALAS = Number(process.env.MAX_SALAS) || 40;
const RAPIDO = Number(process.env.RAPIDO) || 0; // modo de teste: divide a duração das fases por este número

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));
// Endereços desta máquina na rede local, para os amigos entrarem
app.get('/info', (req, res) => {
  const ips = Object.values(require('os').networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  res.json({ porta: PORT, ips: PUBLICO ? [] : ips, publico: PUBLICO });
});

// ---------- Tempos (segundos) ----------
const T = (s) => (RAPIDO ? Math.max(2, Math.round(s / RAPIDO)) : s);
const TEMPO = { preparo: 20, apagao: 60, detetive: 25, dia: 120, votacao: 90 };

// ---------- Mapa ----------
const MAPA = { w: 960, h: 640, tam: 20 };
const CASA = { w: 80, h: 70 };
const COLS_X = [40, 230, 420, 610, 800];
const ROWS_Y = [40, 250, 460];
const RUAS_Y = ROWS_Y.map((y) => y + CASA.h + 25);           // centro das ruas horizontais
const AVENIDAS_X = [10, 175, 365, 555, 745, 925];            // centro das ruas verticais
const NOMES_RUAS = ['Rua de Cima', 'Rua do Meio', 'Rua de Baixo'];

// Estações de tarefa: o ponto (x, y) fica logo abaixo da rua, e o prédio (corpo) ocupa o gramado abaixo dele.
const est = (id, nome, tarefa, x, faixa) => {
  const y = RUAS_Y[faixa] + 40, h = faixa === 2 ? 34 : 50;
  return { id, nome, tarefa, x, y, corpo: { x: x - 34, y: y + 12, w: 68, h } };
};
const ESTACOES = [
  est('mercado', 'Mercado', 'Fazer compras no mercado', 270, 0),
  est('padaria', 'Padaria', 'Buscar pão na padaria', 650, 0),
  est('correio', 'Correio', 'Levar cartas ao correio', 80, 1),
  est('praca', 'Praça', 'Varrer a praça', 460, 1),
  est('igreja', 'Igreja', 'Acender velas na igreja', 840, 1),
  est('lago', 'Lago', 'Pegar água no lago', 90, 2),
  est('parque', 'Parque', 'Passear com o cachorro no parque', 460, 2),
  est('horta', 'Horta', 'Regar a horta', 840, 2),
];

// ---------- Tarefas do dia: etapas em lugares diferentes, cada uma com um minijogo ----------
const CATALOGO = [
  { id: 'compras', nome: 'Fazer compras e guardar em casa', etapas: [{ onde: 'mercado', jogo: 'sequencia', texto: 'Escolha os produtos certos' }, { onde: 'casa', jogo: 'sequencia', texto: 'Guarde as compras no armário' }] },
  { id: 'pao', nome: 'Buscar pão quentinho', etapas: [{ onde: 'padaria', jogo: 'segurar', texto: 'Tire o pão do forno no ponto certo' }] },
  { id: 'cartas', nome: 'Enviar as cartas', etapas: [{ onde: 'casa', jogo: 'sequencia', texto: 'Separe as cartas por endereço' }, { onde: 'correio', jogo: 'martelar', texto: 'Carimbe todas as cartas' }] },
  { id: 'varrer', nome: 'Varrer a praça', etapas: [{ onde: 'praca', jogo: 'martelar', texto: 'Varra as folhas da praça' }] },
  { id: 'velas', nome: 'Acender as velas da igreja', etapas: [{ onde: 'igreja', jogo: 'segurar', texto: 'Acenda cada vela sem deixar apagar' }] },
  { id: 'regar', nome: 'Buscar água e regar a horta', etapas: [{ onde: 'lago', jogo: 'segurar', texto: 'Encha o balde sem derramar' }, { onde: 'horta', jogo: 'martelar', texto: 'Regue os canteiros' }] },
  { id: 'cachorro', nome: 'Passear com o cachorro', etapas: [{ onde: 'casa', jogo: 'sequencia', texto: 'Coloque a coleira no cachorro' }, { onde: 'parque', jogo: 'martelar', texto: 'Jogue a bolinha para o cachorro' }] },
  { id: 'plantar', nome: 'Plantar sementes na horta', etapas: [{ onde: 'horta', jogo: 'sequencia', texto: 'Plante as sementes na ordem certa' }] },
];
const TAREFAS_POR_DIA = 3;
const TEMPO_MIN_JOGO = { sequencia: 5000, martelar: 6000, segurar: 5000, qte: 600 }; // abaixo disso, o servidor recusa
const QTE_SEGUNDOS = 8;

function gerarCasas() {
  const casas = [];
  let id = 0;
  ROWS_Y.forEach((y, r) => COLS_X.forEach((x) => {
    casas.push({ id: id++, x, y, w: CASA.w, h: CASA.h, rua: r, porta: { x: x + CASA.w / 2, y: RUAS_Y[r] }, dono: null, donoNome: null });
  }));
  return casas;
}

const colide = (x, y, casas) => {
  const t = MAPA.tam;
  if (x < 0 || y < 0 || x > MAPA.w - t || y > MAPA.h - t) return true;
  const dentro = (c) => x < c.x + c.w && x + t > c.x && y < c.y + c.h && y + t > c.y;
  return casas.some(dentro) || ESTACOES.some((e) => dentro(e.corpo));
};

// ---------- Funções e composição ----------
const SOMBRA = ['Assassino', 'Traidor', 'Sabotador'];
const COMPOSICAO = {
  6: { Assassino: 1, Médico: 1, Detetive: 1, Cidadão: 3 },
  7: { Assassino: 1, Médico: 1, Detetive: 1, Prefeito: 1, Cidadão: 3 },
  8: { Assassino: 1, Traidor: 1, Médico: 1, Detetive: 1, Prefeito: 1, Cidadão: 3 },
  9: { Assassino: 2, Médico: 1, Detetive: 1, Prefeito: 1, Fofoqueiro: 1, Cidadão: 3 },
  10: { Assassino: 2, Traidor: 1, Médico: 1, Detetive: 1, Prefeito: 1, Fofoqueiro: 1, Cidadão: 3 },
  11: { Assassino: 2, Traidor: 1, Médico: 1, Detetive: 1, Prefeito: 1, Fofoqueiro: 1, Coringa: 1, Cidadão: 3 },
  12: { Assassino: 2, Traidor: 1, Sabotador: 1, Médico: 1, Detetive: 1, Prefeito: 1, Fofoqueiro: 1, Coringa: 1, Cidadão: 3 },
  13: { Assassino: 2, Traidor: 1, Sabotador: 1, Médico: 1, Detetive: 1, Prefeito: 1, Fofoqueiro: 1, Coringa: 1, Cidadão: 4 },
  14: { Assassino: 2, Traidor: 2, Sabotador: 1, Médico: 1, Detetive: 1, Prefeito: 1, Fofoqueiro: 1, Coringa: 1, Cidadão: 4 },
};
function baralho(n) {
  const base = COMPOSICAO[Math.min(n, 14)];
  const cartas = [];
  for (const [f, q] of Object.entries(base)) for (let i = 0; i < q; i++) cartas.push(f);
  while (cartas.length < n) cartas.push('Cidadão'); // acima de 14: mais cidadãos
  return embaralhar(cartas);
}
const embaralhar = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const ladoDe = (j) => (SOMBRA.includes(j.funcao) ? 'Sombra' : 'Vila');
const sorteia = (a) => a[Math.floor(Math.random() * a.length)];

const MIN_JOGADORES = 6, MAX_JOGADORES = 15;
const CORES = ['#e94f37', '#3f88c5', '#f6ae2d', '#44af69', '#9b5de5', '#f15bb5', '#00bbf9', '#fee440', '#8d6e63', '#ff8c42', '#26a69a', '#c0ca33', '#ec407a', '#7e57c2', '#78909c'];
const PERFIS = ['Desconfiado', 'Falante', 'Quieto', 'Impulsivo', 'Analítico'];
const NOMES_BOT = ['Dona Cida', 'Seu Jorge', 'Bia', 'Tião', 'Lúcia', 'Padre Zé', 'Marta', 'Nando', 'Rosa', 'Caio', 'Dalva', 'Beto', 'Júlia', 'Otávio'];

// ---------- Configurações da sala (escolhidas pelo anfitrião) ----------
const CONFIG_PADRAO = { tempo: 'normal', rodadas: 0, ia: 'normal' };
const MULT_TEMPO = { curto: 0.7, normal: 1, longo: 1.4 };
const IA = {
  facil: { limiar: 1.6, chute: 0.5, detRevela: false, coordena: false, mencao: 0.1, mira: false },
  normal: { limiar: 0.6, chute: 0.3, detRevela: true, coordena: true, mencao: 0.3, mira: true },
  dificil: { limiar: 0.3, chute: 0, detRevela: true, coordena: true, mencao: 1, mira: true },
};
const ia = (s) => IA[s.config.ia] || IA.normal;
function aplicarConfig(s, c) {
  c = c || {};
  if (MULT_TEMPO[c.tempo]) s.config.tempo = c.tempo;
  if ([0, 5, 8, 10].includes(+c.rodadas)) s.config.rodadas = +c.rodadas;
  if (IA[c.ia]) s.config.ia = c.ia;
}

// ---------- Salas ----------
const salas = {};

function novaSala(id) {
  return { id, fase: 'LOBBY', rodada: 0, jogadores: {}, casas: [], timer: null, fim: 0, acoes: {}, votos: {}, chat: [], metaTarefas: 0, tarefasFeitas: 0, rastro: [], anfitriao: null, config: { ...CONFIG_PADRAO } };
}

function novoJogador(id, nome, isBot) {
  return { id, nome, isBot, pronto: isBot, funcao: null, vivo: true, preso: false, x: 0, y: 0, casa: null, cor: '#ccc',
    tarefas: [], ocupadoAte: 0, ocupadoEm: null, saiuDeCasa: false, usouAutoProtecao: false, ultimoProtegido: null,
    traidorAlvo: null, traidorUsou: false, coringaReal: null, perfil: sorteia(PERFIS), suspeita: {}, caminho: [], alvoBot: null };
}

// ---------- Envio seguro de estado ----------
function podeAndar(sala, j) {
  if (!j.vivo) return false;
  if (sala.fase === 'DIA') return true;
  if (sala.fase === 'APAGAO') return j.funcao === 'Assassino' || j.funcao === 'Sabotador';
  return false;
}

function quemVe(sala, viewer) {
  // Devolve a lista de jogadores que este viewer pode ver no mapa.
  const todos = Object.values(sala.jogadores);
  if (sala.fase === 'LOBBY') return [];
  if (sala.fase === 'DIA') return todos;
  if (sala.fase === 'APAGAO' && viewer && viewer.vivo && podeAndar(sala, viewer)) {
    if (viewer.funcao === 'Assassino') return todos.filter((j) => j.id === viewer.id || (j.funcao === 'Assassino' && j.vivo));
    return [viewer];
  }
  return [];
}

function telaPreta(sala, viewer) {
  if (['PREPARO', 'APAGAO', 'DETETIVE'].includes(sala.fase)) return !(sala.fase === 'APAGAO' && viewer && podeAndar(sala, viewer));
  return false;
}

function snapshot(sala, viewer) {
  return {
    fase: sala.fase, rodada: sala.rodada, restante: Math.max(0, Math.ceil((sala.fim - Date.now()) / 1000)),
    telaPreta: telaPreta(sala, viewer),
    jogadores: quemVe(sala, viewer).map((j) => ({ id: j.id, nome: j.nome, x: j.x, y: j.y, vivo: j.vivo, cor: j.cor, ocupado: j.ocupadoAte > Date.now() })),
    tarefas: { feitas: sala.tarefasFeitas, meta: sala.metaTarefas },
  };
}

function listaPublica(sala) {
  // Só dados públicos: nome, se está vivo, se foi preso. Nunca a função.
  return Object.values(sala.jogadores).map((j) => ({ id: j.id, nome: j.nome, vivo: j.vivo, preso: j.preso, isBot: j.isBot, pronto: j.pronto, cor: j.cor, casa: j.casa }));
}

const enviarPrivado = (j, ev, dados) => { if (!j.isBot) io.to(j.id).emit(ev, dados); };
const avisar = (j, msg) => enviarPrivado(j, 'msg_secreta', msg);

// ---------- Conexões ----------
io.on('connection', (socket) => {
  // Limite de mensagens: o movimento manda até ~60 por segundo; acima de 150, as mensagens são descartadas,
  // e quem passa de 400 por segundo é desconectado.
  let janela = Date.now(), contagem = 0;
  socket.use((pacote, seguir) => {
    const agora = Date.now();
    if (agora - janela > 1000) { janela = agora; contagem = 0; }
    if (++contagem > 400) return socket.disconnect(true);
    if (contagem > 150) return;
    seguir();
  });
  socket.on('entrar_jogo', ({ nome, sala, senha } = {}) => {
    const limpar = (t, n) => String(t || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
    nome = limpar(nome, 12); sala = limpar(sala, 12).toLowerCase(); senha = limpar(senha, 20);
    if (!nome || !sala || socket.salaAtual) return;
    if (!salas[sala]) {
      if (Object.keys(salas).length >= MAX_SALAS) return socket.emit('erro', 'O servidor está cheio agora. Tente de novo em alguns minutos.');
      salas[sala] = novaSala(sala); salas[sala].senha = senha || null;
    }
    const s = salas[sala];
    if (s.senha && s.senha !== senha) return socket.emit('erro', 'Senha da sala incorreta.');
    if (Object.values(s.jogadores).some((j) => !j.isBot && j.nome.toLowerCase() === nome.toLowerCase())) return socket.emit('erro', 'Já existe alguém com esse nome nesta sala.');
    if (s.fase !== 'LOBBY') return socket.emit('erro', 'A partida desta sala já começou. Espere terminar ou use outra sala.');
    if (Object.values(s.jogadores).filter((j) => !j.isBot).length >= MAX_JOGADORES) return socket.emit('erro', 'Sala cheia.');
    socket.join(sala); socket.salaAtual = sala;
    s.jogadores[socket.id] = novoJogador(socket.id, nome, false);
    if (!s.anfitriao || !s.jogadores[s.anfitriao]) s.anfitriao = socket.id;
    socket.emit('entrou', { id: socket.id, mapa: { ...MAPA, ruas: RUAS_Y, avenidas: AVENIDAS_X, nomesRuas: NOMES_RUAS }, estacoes: ESTACOES });
    atualizarLobby(s);
  });

  const ctx = () => { const s = salas[socket.salaAtual]; return s ? { s, j: s.jogadores[socket.id] } : {}; };

  socket.on('config', (c) => {
    const { s } = ctx(); if (!s || s.fase !== 'LOBBY' || s.anfitriao !== socket.id) return;
    aplicarConfig(s, c); atualizarLobby(s);
  });

  socket.on('toggle_pronto', () => {
    const { s, j } = ctx(); if (!s || !j || s.fase !== 'LOBBY') return;
    j.pronto = !j.pronto; atualizarLobby(s);
    const humanos = Object.values(s.jogadores).filter((p) => !p.isBot);
    if (humanos.length && humanos.every((p) => p.pronto)) iniciarPartida(s);
  });

  socket.on('mover', ({ x, y }) => {
    const { s, j } = ctx(); if (!s || !j || !podeAndar(s, j)) return;
    x = +x; y = +y; if (!isFinite(x) || !isFinite(y)) return;
    if (Math.hypot(x - j.x, y - j.y) > 24) return;            // anti-teleporte
    if (colide(x, y, s.casas)) return;
    if (j.ocupadoAte > Date.now()) return;                     // fazendo tarefa: parado
    j.x = x; j.y = y;
    if (s.fase === 'APAGAO') registrarRastro(s, j);
  });

  socket.on('acao_e', () => { const { s, j } = ctx(); if (s && j) acaoE(s, j); });
  socket.on('minijogo_fim', (d) => { const { s, j } = ctx(); if (s && j && d) fimMinijogo(s, j, d.token, !!d.ok); });
  socket.on('qte_ok', (d) => { const { s, j } = ctx(); if (s && j && d) fimQte(s, j, d.token, String(d.seq || '')); });
  socket.on('escolha_noite', (alvoId) => { const { s, j } = ctx(); if (s && j) escolhaNoite(s, j, alvoId); });
  socket.on('votar', (alvoId) => {
    const { s, j } = ctx(); if (!s || !j || !j.vivo || s.fase !== 'VOTACAO') return;
    if (alvoId !== 'pular' && !(s.jogadores[alvoId] && s.jogadores[alvoId].vivo)) return;
    s.votos[j.id] = alvoId;
    if (alvoId !== 'pular') { j.ameacou = j.ameacou || {}; j.ameacou[alvoId] = true; }
    io.to(s.id).emit('votos_parciais', Object.keys(s.votos).length);
  });
  socket.on('traidor_revelar', (alvoId) => { const { s, j } = ctx(); if (s && j) revelarTraidor(s, j, alvoId); });
  socket.on('chat', (txt) => {
    const { s, j } = ctx(); if (!s || !j || !j.vivo || s.fase !== 'VOTACAO') return;
    txt = String(txt || '').trim().slice(0, 120); if (!txt) return;
    falar(s, j, txt);
  });

  socket.on('disconnect', () => {
    const { s, j } = ctx(); if (!s || !j) return;
    if (s.fase === 'LOBBY') delete s.jogadores[socket.id];
    else { j.isBot = true; j.nome += ' (máquina)'; } // a máquina assume o lugar de quem caiu
    if (!Object.values(s.jogadores).some((p) => !p.isBot)) { clearTimeout(s.timer); delete salas[s.id]; return; }
    atualizarLobby(s);
  });
});

function atualizarLobby(s) {
  if (!s.jogadores[s.anfitriao]) s.anfitriao = (Object.values(s.jogadores).find((j) => !j.isBot) || {}).id || null;
  io.to(s.id).emit('estado_lobby', listaPublica(s));
  io.to(s.id).emit('config_sala', { ...s.config, anfitriao: s.anfitriao });
}
function falar(s, j, txt) { const m = { nome: j.nome, cor: j.cor, txt }; s.chat.push(m); io.to(s.id).emit('chat', m); }

// ---------- Partida ----------
function iniciarPartida(s) {
  let lista = Object.values(s.jogadores);
  const nomes = embaralhar([...NOMES_BOT]);
  while (lista.length < MIN_JOGADORES) {
    const id = 'bot_' + Math.random().toString(36).slice(2, 9);
    s.jogadores[id] = novoJogador(id, nomes.pop() || 'Máquina', true);
    lista = Object.values(s.jogadores);
  }
  s.casas = gerarCasas(); s.rodada = 0; s.tarefasFeitas = 0; s.chat = []; s.acoes = {}; s.votos = {};
  // As funções especiais vão primeiro para as pessoas; a máquina fica com Cidadão sempre que possível.
  const deck = baralho(lista.length);
  const especiais = embaralhar(deck.filter((c) => c !== 'Cidadão')), comuns = deck.filter((c) => c === 'Cidadão');
  lista = [...embaralhar(lista.filter((j) => !j.isBot)), ...embaralhar(lista.filter((j) => j.isBot))];
  const cartas = [...especiais, ...comuns];
  const casasLivres = embaralhar(s.casas.map((c) => c.id));
  lista.forEach((j, i) => {
    Object.assign(j, { funcao: cartas[i], vivo: true, preso: false, cor: CORES[i % CORES.length], traidorAlvo: null, traidorUsou: false,
      coringaReal: null, usouAutoProtecao: false, ultimoProtegido: null, suspeita: {}, tarefas: [] });
    const casa = s.casas[casasLivres[i]]; casa.dono = j.id; casa.donoNome = j.nome; j.casa = casa.id;
    irParaCasa(j, casa);
    enviarPrivado(j, 'sua_carta', { funcao: j.funcao, aliados: aliadosDe(s, j) });
  });
  const vila = lista.filter((j) => ladoDe(j) === 'Vila').length;
  s.metaTarefas = vila * 5; // tarefas longas: cada pessoa termina ~2 por dia, então a meta leva 3 a 4 dias
  io.to(s.id).emit('mapa_vila', s.casas.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, porta: c.porta, donoNome: c.donoNome })));
  atualizarLobby(s);
  novaNoite(s);
}

function aliadosDe(s, j) {
  if (j.funcao !== 'Assassino') return [];
  return Object.values(s.jogadores).filter((p) => p.id !== j.id && p.funcao === 'Assassino').map((p) => p.nome);
}
function irParaCasa(j, casa) { j.x = casa.porta.x - MAPA.tam / 2; j.y = casa.porta.y - MAPA.tam / 2; }
const casaDe = (s, j) => s.casas[j.casa];

function mudarFase(s, fase, segundos, depois) {
  segundos = segundos * (MULT_TEMPO[s.config.tempo] || 1);
  s.fase = fase; s.fim = Date.now() + T(segundos) * 1000;
  Object.values(s.jogadores).forEach((j) => { j.jogo = null; j.qte = null; j.trabalhando = null; j.ocupadoAte = 0; });
  io.to(s.id).emit('fase', { fase, rodada: s.rodada, segundos: T(segundos) });
  clearTimeout(s.timer);
  s.timer = setTimeout(() => { if (salas[s.id] === s) depois(); }, T(segundos) * 1000);
}

// ----- Noite -----
function novaNoite(s) {
  s.rodada++; s.acoes = { protegido: null, protetor: null, trancadas: new Set(), vitima: null, fofoca: null };
  s.rastro = [];
  const vivos = Object.values(s.jogadores).filter((j) => j.vivo);
  vivos.forEach((j) => { j.saiuDeCasa = false; j.caminho = []; j.alvoBot = null; irParaCasa(j, casaDe(s, j)); });

  // Coringa descobre a função no início da noite 2
  if (s.rodada === 2) vivos.filter((j) => j.funcao === 'Coringa').forEach((j) => {
    const emJogo = new Set(Object.values(s.jogadores).map((p) => p.funcao));
    const opcoes = ['Médico', 'Detetive', 'Fofoqueiro', 'Sabotador', 'Cidadão'].filter((f) => f === 'Cidadão' || !emJogo.has(f));
    j.funcao = sorteia(opcoes); j.coringaReal = j.funcao;
    enviarPrivado(j, 'sua_carta', { funcao: j.funcao, coringa: true, aliados: [] });
    avisar(j, `🃏 O Coringa revelou sua função: ${j.funcao}.`);
  });

  mudarFase(s, 'PREPARO', TEMPO.preparo, () => apagao(s));
  // Quem escolhe antes do apagão: Médico, Fofoqueiro e Traidor (só na noite 1)
  vivos.forEach((j) => {
    const opcoes = vivos.filter((p) => p.id !== j.id).map((p) => ({ id: p.id, nome: p.nome }));
    if (j.funcao === 'Médico') {
      const lista = vivos.filter((p) => p.id !== j.ultimoProtegido && (p.id !== j.id || !j.usouAutoProtecao)).map((p) => ({ id: p.id, nome: p.id === j.id ? p.nome + ' (você)' : p.nome }));
      enviarPrivado(j, 'pedir_escolha', { titulo: 'Médico: quem você protege esta noite?', opcoes: lista });
    } else if (j.funcao === 'Fofoqueiro') enviarPrivado(j, 'pedir_escolha', { titulo: 'Fofoqueiro: com quem você troca informações?', opcoes });
    else if (j.funcao === 'Traidor' && s.rodada === 1) enviarPrivado(j, 'pedir_escolha', { titulo: 'Traidor: qual aliado você vai trair?', opcoes });
  });
  botsPreparo(s);

}

function escolhaNoite(s, j, alvoId) {
  if (!j.vivo || !s.jogadores[alvoId] || !s.jogadores[alvoId].vivo || j.qte) return;
  const alvo = s.jogadores[alvoId];
  if (s.fase === 'PREPARO') {
    if (j.funcao === 'Médico') {
      if (alvoId === j.ultimoProtegido || (alvoId === j.id && j.usouAutoProtecao)) return;
      comQte(s, j, `Proteger ${alvo.nome}`, () => { if (s.fase !== 'PREPARO') return; s.acoes.protegido = alvoId; s.acoes.protetor = j.id; avisar(j, '💉 Proteção marcada.'); });
    } else if (j.funcao === 'Fofoqueiro') { s.acoes.fofoca = { de: j.id, com: alvoId }; avisar(j, '💬 Conversa marcada para o fim da noite.'); }
    else if (j.funcao === 'Traidor' && s.rodada === 1 && alvoId !== j.id) { j.traidorAlvo = alvoId; avisar(j, '🎭 Aliado escolhido.'); }
  } else if (s.fase === 'DETETIVE' && j.funcao === 'Detetive' && !s.acoes.investigado) {
    comQte(s, j, `Investigar ${alvo.nome}`, () => { if (s.fase !== 'DETETIVE' || s.acoes.investigado) return; s.acoes.investigado = alvoId; investigar(s, j, alvoId); });
  }
}

// Ações da noite pedem uma sequência rápida de 4 teclas WASD. A máquina age direto.
function comQte(s, j, titulo, acao) {
  if (j.isBot) return acao();
  const seq = Array.from({ length: 4 }, () => sorteia(['W', 'A', 'S', 'D'])).join('');
  const token = Math.random().toString(36).slice(2);
  j.qte = { token, seq, acao, inicio: Date.now() };
  j.ocupadoAte = Date.now() + QTE_SEGUNDOS * 1000;
  enviarPrivado(j, 'qte', { token, seq, titulo, segundos: QTE_SEGUNDOS });
}
function fimQte(s, j, token, seq) {
  const q = j.qte; if (!q || q.token !== token) return;
  j.qte = null; j.ocupadoAte = 0;
  const dur = Date.now() - q.inicio;
  if (dur > QTE_SEGUNDOS * 1000 + 500) return avisar(j, '⌛ Demorou demais. Tente de novo.');
  if (seq !== q.seq || dur < TEMPO_MIN_JOGO.qte || !j.vivo) return;
  q.acao();
}

function apagao(s) {
  const vivos = Object.values(s.jogadores).filter((j) => j.vivo);
  vivos.forEach((j) => {
    if (j.funcao === 'Assassino') avisar(j, '🔪 Apagão. Vá até a porta da vítima e aperte E.');
    else if (j.funcao === 'Sabotador') avisar(j, '🔧 Apagão. Vá até uma porta e aperte E para trancar a casa.');
    else avisar(j, '🌑 A vila dorme…');
  });
  botsApagao(s);
  mudarFase(s, 'APAGAO', TEMPO.apagao, () => turnoDetetive(s));
}

function registrarRastro(s, j) {
  const c = casaDe(s, j);
  if (Math.hypot(j.x + 10 - c.porta.x, j.y + 10 - c.porta.y) > 40) j.saiuDeCasa = true;
  if (j.funcao !== 'Assassino') return;
  const lugar = lugarDe(j.x + 10, j.y + 10, s);
  if (lugar && s.rastro[s.rastro.length - 1] !== lugar) s.rastro.push(lugar);
}

function lugarDe(x, y, s) {
  const est = ESTACOES.find((e) => Math.hypot(x - e.x, y - e.y) < 55);
  if (est) return est.nome;
  const casa = s.casas.find((c) => Math.hypot(x - c.porta.x, y - c.porta.y) < 35 && c.donoNome);
  if (casa) return `porta da casa de ${casa.donoNome}`;
  const r = RUAS_Y.findIndex((ry) => Math.abs(y - ry) < 30);
  return r >= 0 ? NOMES_RUAS[r] : null;
}

function acaoE(s, j) {
  if (!j.vivo || j.qte) return;
  const cx = j.x + 10, cy = j.y + 10;
  if (s.fase === 'APAGAO') {
    const casa = s.casas.find((c) => c.dono && Math.hypot(cx - c.porta.x, cy - c.porta.y) < 40);
    if (!casa) return avisar(j, 'Chegue mais perto de uma porta.');
    const perto = () => Math.hypot(j.x + 10 - casa.porta.x, j.y + 10 - casa.porta.y) < 45;
    if (j.funcao === 'Assassino') {
      const alvo = s.jogadores[casa.dono];
      if (!alvo || !alvo.vivo || alvo.funcao === 'Assassino') return avisar(j, 'Não dá para atacar esta casa.');
      if (s.acoes.vitima) return avisar(j, 'Já há uma vítima marcada esta noite.');
      comQte(s, j, `Atacar ${alvo.nome}`, () => {
        if (s.fase !== 'APAGAO' || s.acoes.vitima || !alvo.vivo || !perto()) return;
        s.acoes.vitima = alvo.id; s.acoes.assassino = j.id;
        avisar(j, `🔪 ${alvo.nome} foi atacado(a).`);
        enviarPrivado(alvo, 'ataque', 'Alguém forçou a sua porta no escuro…');
        Object.values(s.jogadores).filter((p) => p.funcao === 'Assassino' && p.id !== j.id).forEach((p) => avisar(p, `🔪 Seu parceiro atacou ${alvo.nome}.`));
      });
    } else if (j.funcao === 'Sabotador') {
      comQte(s, j, `Trancar a casa de ${casa.donoNome}`, () => { if (s.fase !== 'APAGAO' || !perto()) return; s.acoes.trancadas.add(casa.id); avisar(j, `🔧 Casa de ${casa.donoNome} trancada.`); });
    }
    return;
  }
  if (s.fase === 'DIA' && !j.isBot) {
    if (j.ocupadoAte > Date.now()) return;
    const t = j.tarefas.find((t) => { if (t.feita) return false; const l = localDaEtapa(s, j, t.etapas[t.etapa]); return Math.hypot(cx - l.x, cy - l.y) < 50; });
    if (!t) return avisar(j, 'Nenhuma tarefa sua por aqui.');
    const etapa = t.etapas[t.etapa];
    j.ocupadoAte = Date.now() + TEMPO.dia * 1000;
    j.jogo = { token: Math.random().toString(36).slice(2), tarefa: t, inicio: Date.now(), tipo: etapa.jogo, local: localDaEtapa(s, j, etapa) };
    enviarPrivado(j, 'minijogo', { tipo: etapa.jogo, texto: etapa.texto, titulo: t.nome, token: j.jogo.token, nivel: s.rodada });
  }
}

function localDaEtapa(s, j, etapa) {
  if (etapa.onde === 'casa') { const c = casaDe(s, j); return { x: c.porta.x, y: c.porta.y, nome: 'sua casa' }; }
  const e = ESTACOES.find((e) => e.id === etapa.onde); return { x: e.x, y: e.y, nome: e.nome };
}
function descreverTarefas(s, j) {
  return j.tarefas.map((t) => ({ nome: t.nome, feita: t.feita, etapa: t.etapa, total: t.etapas.length, onde: t.feita ? null : localDaEtapa(s, j, t.etapas[t.etapa]).nome }));
}
function fimMinijogo(s, j, token, ok) {
  const jg = j.jogo; if (!jg || jg.token !== token) return;
  j.jogo = null; j.ocupadoAte = 0;
  if (!ok || s.fase !== 'DIA' || !j.vivo) return;
  if (Date.now() - jg.inicio < TEMPO_MIN_JOGO[jg.tipo]) return avisar(j, 'Rápido demais… tente de novo.');
  if (Math.hypot(j.x + 10 - jg.local.x, j.y + 10 - jg.local.y) > 60) return;
  avancarEtapa(s, j, jg.tarefa);
}
function avancarEtapa(s, j, t) {
  if (s.fase !== 'DIA' || t.feita) return;
  t.etapa++;
  if (t.etapa >= t.etapas.length) {
    t.feita = true;
    avisar(j, ladoDe(j) === 'Vila' ? `✅ ${t.nome}` : `🎭 Você fingiu: ${t.nome}`);
    enviarPrivado(j, 'suas_tarefas', descreverTarefas(s, j));
    if (ladoDe(j) === 'Vila') { s.tarefasFeitas++; io.to(s.id).emit('atualizar_tarefas', { feitas: s.tarefasFeitas, meta: s.metaTarefas }); verificarVitoria(s); }
    return;
  }
  avisar(j, `➡️ Próxima etapa: ${localDaEtapa(s, j, t.etapas[t.etapa]).nome}.`);
  enviarPrivado(j, 'suas_tarefas', descreverTarefas(s, j));
}

// ----- Detetive -----
function turnoDetetive(s) {
  s.acoes.investigado = null;
  mudarFase(s, 'DETETIVE', TEMPO.detetive, () => resolverNoite(s)); // a fase é anunciada antes do pedido de escolha
  const det = Object.values(s.jogadores).find((j) => j.vivo && j.funcao === 'Detetive');
  if (det) {
    const opcoes = Object.values(s.jogadores).filter((p) => p.vivo && p.id !== det.id).map((p) => ({ id: p.id, nome: p.nome }));
    enviarPrivado(det, 'pedir_escolha', { titulo: 'Detetive: quem você investiga?', opcoes });
    if (det.isBot) setTimeout(() => botDetetive(s, det), 1500);
  }
}

function investigar(s, det, alvoId) {
  if (s.acoes.trancadas.has(det.casa)) return avisar(det, '🔒 Algo deu errado esta noite. Você não conseguiu sair para investigar.');
  const alvo = s.jogadores[alvoId];
  const pistas = [];
  pistas.push(alvo.saiuDeCasa ? `${alvo.nome} SAIU de casa esta noite.` : `${alvo.nome} ficou em casa esta noite.`);
  const rastro = s.rastro.filter((l) => !l.startsWith('porta'));
  if (rastro.length) {
    const p = sorteia(rastro);
    pistas.push(sorteia([`Há pegadas de lama perto de: ${p}.`, `Um lampião foi derrubado em: ${p}.`, `Alguém ouviu passos apressados em: ${p}.`]));
  } else pistas.push('Nenhum rastro claro pelas ruas esta noite.');
  det.pistas = (det.pistas || []).concat([{ rodada: s.rodada, alvo: alvo.id, saiu: alvo.saiuDeCasa }]);
  det.pistasTexto = (det.pistasTexto || []).concat([`R${s.rodada}: ${pistas.join(' ')}`]);
  enviarPrivado(det, 'pista', pistas);
  avisar(det, '🕵️ ' + pistas.join(' '));
}

function resolverNoite(s) {
  const a = s.acoes;
  let manchete = 'A noite foi tranquila. Ninguém morreu.';
  const protetor = s.jogadores[a.protetor];
  if (protetor) { protetor.ultimoProtegido = a.protegido; if (a.protegido === protetor.id) protetor.usouAutoProtecao = true; }
  const protecaoValida = protetor && !a.trancadas.has(protetor.casa) && !(a.protegido && a.trancadas.has(s.jogadores[a.protegido].casa));
  if (a.vitima) {
    const v = s.jogadores[a.vitima];
    if (protecaoValida && a.protegido === v.id) manchete = 'Um ataque aconteceu, mas o Médico salvou a vítima a tempo!';
    else { v.vivo = false; manchete = `TRAGÉDIA! ${v.nome} foi encontrado(a) sem vida.`; enviarPrivado(v, 'voce_morreu', { tipo: 'morte', texto: 'Você foi atacado(a) durante o apagão.' }); herdarDetetive(s, v); }
  }
  // Fofoqueiro: troca de cartas no fim da noite
  if (a.fofoca) {
    const f = s.jogadores[a.fofoca.de], o = s.jogadores[a.fofoca.com];
    if (f && o && f.vivo && o.vivo) {
      if (a.trancadas.has(f.casa)) avisar(f, '🔒 Algo deu errado esta noite. A conversa não aconteceu.');
      else { avisar(f, `💬 ${o.nome} é ${o.funcao}.`); avisar(o, `💬 O Fofoqueiro ${f.nome} veio conversar: ele é Fofoqueiro.`); if (o.isBot) o.suspeita[f.id] = -1; if (f.isBot) f.suspeita[o.id] = ladoDe(o) === 'Sombra' ? 3 : -1; }
    }
  }
  io.to(s.id).emit('gazeta', manchete);
  atualizarLobby(s);
  if (!verificarVitoria(s)) dia(s);
}

// Se o Detetive sai do jogo, um Cidadão vivo herda a função e o caderno de pistas.
function herdarDetetive(s, saiu) {
  if (saiu.funcao !== 'Detetive') return;
  const cand = Object.values(s.jogadores).filter((p) => p.vivo && p.funcao === 'Cidadão');
  if (!cand.length) return;
  const novo = sorteia(cand);
  novo.funcao = 'Detetive'; novo.pistas = [...(saiu.pistas || [])]; novo.pistasTexto = [...(saiu.pistasTexto || [])];
  enviarPrivado(novo, 'sua_carta', { funcao: 'Detetive', herdouDetetive: true, aliados: [] });
  enviarPrivado(novo, 'caderno', novo.pistasTexto);
  avisar(novo, '🕵️ O Detetive saiu do jogo. Você herdou o caderno dele e agora é o Detetive.');
}

// ----- Dia -----
function dia(s) {
  const vivos = Object.values(s.jogadores).filter((j) => j.vivo);
  vivos.forEach((j) => {
    j.tarefas = embaralhar([...CATALOGO]).slice(0, TAREFAS_POR_DIA).map((t) => ({ id: t.id, nome: t.nome, etapas: t.etapas, etapa: 0, feita: false }));
    j.trabalhando = null;
    enviarPrivado(j, 'suas_tarefas', descreverTarefas(s, j));
  });
  mudarFase(s, 'DIA', TEMPO.dia, () => votacao(s));
}

// ----- Votação -----
function votacao(s) {
  s.votos = {}; s.traidorRevelacao = null;
  Object.values(s.jogadores).forEach((j) => { j.tarefas = []; j.ocupadoAte = 0; enviarPrivado(j, 'suas_tarefas', []); });
  const vivos = Object.values(s.jogadores).filter((j) => j.vivo);
  vivos.forEach((j) => { if (j.funcao === 'Traidor' && !j.traidorUsou && j.traidorAlvo && s.jogadores[j.traidorAlvo].vivo) enviarPrivado(j, 'traidor_pode_revelar', s.jogadores[j.traidorAlvo].nome); });
  io.to(s.id).emit('abrir_votacao', listaPublica(s).filter((p) => p.vivo));
  botsVotacao(s);
  mudarFase(s, 'VOTACAO', TEMPO.votacao, () => apurar(s));
}

function revelarTraidor(s, j, alvoId) {
  if (s.fase !== 'VOTACAO' || j.funcao !== 'Traidor' || j.traidorUsou || !j.vivo) return;
  const aliado = s.jogadores[j.traidorAlvo];
  if (!aliado || !aliado.vivo || !(s.jogadores[alvoId] && s.jogadores[alvoId].vivo)) return;
  j.traidorUsou = true; s.traidorRevelacao = { traidor: j.id, aliado: aliado.id, alvo: alvoId };
  io.to(s.id).emit('gazeta', `🎭 ${j.nome} se revelou TRAIDOR! O voto de ${aliado.nome} agora vai para ${s.jogadores[alvoId].nome}.`);
}

function apurar(s) {
  const votos = { ...s.votos };
  if (s.traidorRevelacao) votos[s.traidorRevelacao.aliado] = s.traidorRevelacao.alvo;
  const cont = {};
  Object.values(votos).forEach((v) => { if (v !== 'pular' && s.jogadores[v] && s.jogadores[v].vivo) cont[v] = (cont[v] || 0) + 1; });
  const max = Math.max(0, ...Object.values(cont));
  let empatados = Object.keys(cont).filter((id) => cont[id] === max && max > 0);
  let msg = 'A Vila votou. ';
  if (empatados.length > 1) {
    const pref = Object.values(s.jogadores).find((j) => j.vivo && j.funcao === 'Prefeito');
    if (pref && empatados.includes(votos[pref.id])) { empatados = [votos[pref.id]]; msg += `Empate! O Prefeito ${pref.nome} desempatou. `; }
  }
  if (empatados.length !== 1) msg += 'Ninguém foi preso.';
  else {
    const c = s.jogadores[empatados[0]];
    c.vivo = false; c.preso = true;
    enviarPrivado(c, 'voce_morreu', { tipo: 'prisao', texto: 'A vila votou e você foi preso(a).' });
    herdarDetetive(s, c);
    const assassinosSoltos = () => Object.values(s.jogadores).filter((j) => j.vivo && j.funcao === 'Assassino');
    if (c.funcao === 'Assassino') {
      msg += `${c.nome} foi preso(a). O Assassino foi PRESO!`;
      if (!assassinosSoltos().length) {
        const sab = Object.values(s.jogadores).find((j) => j.vivo && j.funcao === 'Sabotador');
        if (sab) { sab.funcao = 'Assassino'; enviarPrivado(sab, 'sua_carta', { funcao: 'Assassino', herdou: true, aliados: [] }); avisar(sab, '🔪 O Assassino caiu. Agora você é o Assassino.'); }
      } else msg += ' Mas a noite ainda guarda perigo…';
    } else msg += `${c.nome} foi preso(a). O Assassino segue solto entre nós…`;
    // os bots da Vila aprendem com o resultado
    Object.values(s.jogadores).filter((b) => b.isBot && b.vivo).forEach((b) => Object.entries(votos).forEach(([eleitor, alvo]) => {
      if (alvo === c.id && c.funcao !== 'Assassino') b.suspeita[eleitor] = (b.suspeita[eleitor] || 0) + 0.6;
    }));
  }
  io.to(s.id).emit('gazeta', msg);
  atualizarLobby(s);
  if (verificarVitoria(s)) return;
  if (s.config.rodadas && s.rodada >= s.config.rodadas) return encerrar(s, 'sombra', 'A SOMBRA VENCEU! As rodadas acabaram e o Assassino segue solto.');
  novaNoite(s);
}

function verificarVitoria(s) {
  if (s.fase === 'LOBBY') return true;
  const vivos = Object.values(s.jogadores).filter((j) => j.vivo);
  const matadores = vivos.filter((j) => j.funcao === 'Assassino' || j.funcao === 'Sabotador').length;
  const sombra = vivos.filter((j) => ladoDe(j) === 'Sombra').length;
  const vila = vivos.length - sombra;
  if (matadores === 0) return encerrar(s, 'vila', 'A VILA VENCEU! Os Assassinos foram presos.');
  if (s.tarefasFeitas >= s.metaTarefas) return encerrar(s, 'vila', 'A VILA VENCEU! As tarefas da cidade foram concluídas.');
  if (sombra >= vila) return encerrar(s, 'sombra', 'A SOMBRA VENCEU! A vila não tem mais como reagir.');
  return false;
}

function encerrar(s, vencedor, texto) {
  const revelacao = Object.values(s.jogadores).map((j) => ({ nome: j.nome, cor: j.cor, funcao: j.coringaReal ? `Coringa → ${j.coringaReal}` : j.funcao, lado: ladoDe(j), vivo: j.vivo, preso: j.preso }));
  io.to(s.id).emit('fim_de_jogo', { texto, vencedor, revelacao, rodadas: s.rodada });
  voltarParaLobby(s);
  return true;
}

function voltarParaLobby(s) {
  clearTimeout(s.timer); s.fase = 'LOBBY';
  Object.values(s.jogadores).forEach((j) => { if (j.isBot) delete s.jogadores[j.id]; else { j.pronto = false; j.funcao = null; j.vivo = true; j.preso = false; } });
  io.to(s.id).emit('fase', { fase: 'LOBBY', rodada: 0, segundos: 0 });
  atualizarLobby(s);
}

// ---------- Bots ----------
function suspeitos(s, bot) {
  return Object.values(s.jogadores).filter((p) => p.vivo && p.id !== bot.id).sort((a, b) => (bot.suspeita[b.id] || 0) - (bot.suspeita[a.id] || 0));
}

function botsPreparo(s) {
  Object.values(s.jogadores).filter((b) => b.isBot && b.vivo).forEach((b) => {
    const outros = Object.values(s.jogadores).filter((p) => p.vivo && p.id !== b.id);
    if (b.funcao === 'Médico') {
      const opcoes = Object.values(s.jogadores).filter((p) => p.vivo && p.id !== b.ultimoProtegido && (p.id !== b.id || !b.usouAutoProtecao));
      const conf = s.config.ia === 'facil' ? [] : opcoes.filter((p) => (b.suspeita[p.id] || 0) <= 0);
      const alvo = sorteia(conf.length ? conf : opcoes);
      if (alvo) escolhaNoite(s, b, alvo.id);
    } else if (b.funcao === 'Fofoqueiro' && Math.random() < 0.7) escolhaNoite(s, b, sorteia(outros).id);
    else if (b.funcao === 'Traidor' && s.rodada === 1) escolhaNoite(s, b, sorteia(outros).id);
  });
}

function rota(s, de, para) {
  // ruas horizontais e avenidas verticais: vai até a avenida mais próxima, muda de rua e segue
  const pts = [];
  const ruaDe = RUAS_Y.reduce((a, r) => (Math.abs(r - de.y) < Math.abs(a - de.y) ? r : a));
  const ruaPara = RUAS_Y.reduce((a, r) => (Math.abs(r - para.y) < Math.abs(a - para.y) ? r : a));
  pts.push({ x: de.x, y: ruaDe });
  if (ruaDe !== ruaPara) {
    const av = AVENIDAS_X.reduce((a, v) => (Math.abs(v - (de.x + para.x) / 2) < Math.abs(a - (de.x + para.x) / 2) ? v : a));
    pts.push({ x: av, y: ruaDe }, { x: av, y: ruaPara });
  }
  pts.push({ x: para.x, y: ruaPara }, { x: para.x, y: para.y });
  return pts;
}

function botsApagao(s) {
  Object.values(s.jogadores).filter((b) => b.isBot && b.vivo).forEach((b) => {
    if (b.funcao === 'Assassino' && !s.acoes.vitima) {
      const alvos = Object.values(s.jogadores).filter((p) => p.vivo && p.funcao !== 'Assassino');
      // prioridade: quem desconfia dele, depois quem fala muito, depois ao acaso
      const ameacas = ia(s).mira ? alvos.filter((p) => p.ameacou && p.ameacou[b.id]) : [];
      const alvo = sorteia(ameacas.length ? ameacas : alvos);
      if (!alvo) return;
      b.alvoBot = { tipo: 'matar', casa: casaDe(s, alvo).id };
      b.caminho = rota(s, { x: b.x + 10, y: b.y + 10 }, casaDe(s, alvo).porta);
      b.esperaAte = Date.now() + T(4 + Math.random() * 8) * 1000;
    } else if (b.funcao === 'Sabotador') {
      const alvo = sorteia(Object.values(s.jogadores).filter((p) => p.vivo && p.id !== b.id));
      if (!alvo) return;
      b.alvoBot = { tipo: 'trancar', casa: casaDe(s, alvo).id };
      b.caminho = rota(s, { x: b.x + 10, y: b.y + 10 }, casaDe(s, alvo).porta);
      b.esperaAte = Date.now() + T(2 + Math.random() * 6) * 1000;
    }
  });
}

function botDetetive(s, det) {
  if (s.fase !== 'DETETIVE' || !det.vivo) return;
  const ja = new Set((det.pistas || []).map((p) => p.alvo));
  const cand = suspeitos(s, det).filter((p) => !ja.has(p.id));
  const alvo = cand[0] && Math.random() < 0.6 ? cand[0] : sorteia(cand.length ? cand : suspeitos(s, det));
  if (!alvo) return;
  escolhaNoite(s, det, alvo.id);
  const ult = det.pistas && det.pistas[det.pistas.length - 1];
  if (ult && ult.saiu) det.suspeita[ult.alvo] = (det.suspeita[ult.alvo] || 0) + 5;
  else if (ult) det.suspeita[ult.alvo] = (det.suspeita[ult.alvo] || 0) - 1;
}

function botsDia(s) {
  Object.values(s.jogadores).filter((b) => b.isBot && b.vivo).forEach((b) => {
    if (b.caminho.length || b.ocupadoAte > Date.now()) return;
    if (b.trabalhando) { const t = b.trabalhando; b.trabalhando = null; avancarEtapa(s, b, t); return; }
    const t = b.tarefas.find((t) => !t.feita);
    if (t) {
      const l = localDaEtapa(s, b, t.etapas[t.etapa]);
      if (Math.hypot(b.x + 10 - l.x, b.y + 10 - l.y) < 30) {
        // a máquina "joga" o minijogo: leva de 14 a 30 s, e a Sombra demora um pouco mais
        b.trabalhando = t; b.ocupadoAte = Date.now() + T(14 + Math.random() * 16) * 1000 * (ladoDe(b) === 'Sombra' ? 1.3 : 1);
      } else { b.alvoBot = { tipo: 'tarefa' }; b.caminho = rota(s, { x: b.x + 10, y: b.y + 10 }, { x: l.x, y: l.y }); }
    } else if (Math.random() < 0.02) {
      const est = sorteia(ESTACOES); b.alvoBot = { tipo: 'passeio' };
      b.caminho = rota(s, { x: b.x + 10, y: b.y + 10 }, { x: est.x + (Math.random() * 60 - 30), y: est.y - 25 });
    }
  });
}

function passoBot(s, b, dt) {
  if (!b.caminho.length || b.ocupadoAte > Date.now() || (b.esperaAte && Date.now() < b.esperaAte)) return;
  const alvo = b.caminho[0];
  const cx = b.x + 10, cy = b.y + 10;
  const dx = alvo.x - cx, dy = alvo.y - cy, d = Math.hypot(dx, dy);
  const vel = 120 * dt; // px por segundo
  if (d <= vel) {
    b.x = alvo.x - 10; b.y = alvo.y - 10; b.caminho.shift();
    if (s.fase === 'APAGAO') registrarRastro(s, b);
    if (!b.caminho.length) chegou(s, b);
    return;
  }
  const nx = b.x + (dx / d) * vel, ny = b.y + (dy / d) * vel;
  if (!colide(nx, ny, s.casas)) { b.x = nx; b.y = ny; } else { b.caminho = []; b.alvoBot = null; } // travou: desiste e tenta outro plano
  if (s.fase === 'APAGAO') registrarRastro(s, b);
}

function chegou(s, b) {
  const a = b.alvoBot; b.alvoBot = null; if (!a) return;
  if (a.tipo === 'matar' || a.tipo === 'trancar') {
    acaoE(s, b);
    if (s.fase === 'APAGAO') b.caminho = rota(s, { x: b.x + 10, y: b.y + 10 }, casaDe(s, b).porta); // volta para casa
  }
}

const FALAS = {
  acusar: ['Estou de olho em {x}.', 'Acho que foi {x}.', '{x} estava estranho(a) hoje.', 'Voto em {x}, não confio.'],
  pular: ['Ainda não tenho certeza de nada.', 'Melhor não prender inocente.', 'Vou pular desta vez.'],
  detetive: ['Eu vi {x} fora de casa à noite!', '{x} saiu de casa no apagão, tenho certeza.'],
  defesa: ['Não fui eu, eu estava em casa!', 'Estão me acusando à toa.'],
};
const fala = (tipo, x) => sorteia(FALAS[tipo]).replace('{x}', x || '');

function botsVotacao(s) {
  const bots = Object.values(s.jogadores).filter((b) => b.isBot && b.vivo);
  const vivos = Object.values(s.jogadores).filter((p) => p.vivo);
  // a Sombra combina um alvo da Vila (os Assassinos se conhecem)
  const alvoSombra = sorteia(vivos.filter((p) => ladoDe(p) === 'Vila'));
  bots.forEach((b, i) => {
    const atraso = T(5 + i * 3 + Math.random() * 10) * 1000;
    setTimeout(() => {
      if (salas[s.id] !== s || s.fase !== 'VOTACAO' || !b.vivo) return;
      let voto = 'pular', txt;
      if (b.funcao === 'Detetive') {
        const vistos = (b.pistas || []).filter((p) => p.saiu && s.jogadores[p.alvo].vivo);
        if (vistos.length && ia(s).detRevela) {
          voto = vistos[vistos.length - 1].alvo; txt = fala('detetive', s.jogadores[voto].nome);
          if (s.config.ia === 'dificil') bots.forEach((o) => { if (o !== b && ladoDe(o) === 'Vila') o.suspeita[voto] = (o.suspeita[voto] || 0) + 2; });
        }
      }
      if (voto === 'pular' && ladoDe(b) === 'Sombra') {
        const alvo = ia(s).coordena ? alvoSombra : sorteia(vivos.filter((p) => ladoDe(p) === 'Vila'));
        if (alvo && Math.random() < (ia(s).coordena ? 0.85 : 0.5)) { voto = alvo.id; txt = fala('acusar', alvo.nome); }
      } else if (voto === 'pular') {
        const top = suspeitos(s, b)[0];
        const limite = (b.perfil === 'Impulsivo' ? 0.2 : b.perfil === 'Desconfiado' ? 0.4 : 0.8) * ia(s).limiar / 0.6;
        if (top && (b.suspeita[top.id] || 0) > limite) { voto = top.id; txt = fala('acusar', top.nome); }
        else if (s.rodada > 1 && Math.random() < ia(s).chute) { const x = sorteia(vivos.filter((p) => p.id !== b.id)); voto = x.id; txt = fala('acusar', x.nome); }
      }
      if (!txt && b.perfil !== 'Quieto') txt = fala('pular');
      if (txt && (b.perfil !== 'Quieto' || Math.random() < 0.3)) falar(s, b, txt);
      s.votos[b.id] = voto;
      if (voto !== 'pular') { b.ameacou = b.ameacou || {}; b.ameacou[voto] = true; }
      io.to(s.id).emit('votos_parciais', Object.keys(s.votos).length);
      // Traidor da máquina: às vezes se revela para virar a votação
      if (b.funcao === 'Traidor' && !b.traidorUsou && b.traidorAlvo && s.rodada > 1 && Math.random() < 0.3 && alvoSombra) revelarTraidor(s, b, alvoSombra.id);
    }, Math.min(atraso, T(TEMPO.votacao - 5) * 1000));
  });
}

// humanos que acusam viram alvo preferencial do Assassino da máquina
io.on('connection', (socket) => {
  socket.on('chat', (txt) => {
    const s = salas[socket.salaAtual]; if (!s || s.fase !== 'VOTACAO') return;
    const j = s.jogadores[socket.id]; if (!j) return;
    Object.values(s.jogadores).forEach((p) => { if (p.funcao === 'Assassino' && String(txt).toLowerCase().includes(p.nome.toLowerCase())) { j.ameacou = j.ameacou || {}; j.ameacou[p.id] = true; } });
    // bots da Vila ganham um pouco de suspeita sobre quem foi citado
    Object.values(s.jogadores).filter((b) => b.isBot && b.vivo && ladoDe(b) === 'Vila').forEach((b) => Object.values(s.jogadores).forEach((p) => {
      if (p.id !== b.id && String(txt).toLowerCase().includes(p.nome.toLowerCase())) b.suspeita[p.id] = (b.suspeita[p.id] || 0) + ia(s).mencao;
    }));
  });
});

// ---------- Laços ----------
let ultimo = Date.now();
setInterval(() => {
  const agora = Date.now(), dt = Math.min(0.1, (agora - ultimo) / 1000); ultimo = agora;
  for (const s of Object.values(salas)) {
    if (s.fase === 'LOBBY') continue;
    if (s.fase === 'DIA') botsDia(s);
    Object.values(s.jogadores).forEach((b) => { if (b.isBot && podeAndar(s, b)) passoBot(s, b, dt); });
    for (const j of Object.values(s.jogadores)) if (!j.isBot) io.to(j.id).emit('tick', snapshot(s, j));
  }
}, 1000 / 20);

server.on('error', (e) => console.error('Não foi possível abrir a porta ' + PORT + ':', e.message));
server.listen(PORT, () => console.log(`Noite na Vila rodando em http://localhost:${PORT}${RAPIDO ? ' (modo rápido)' : ''}`));
module.exports = { server, PORT };
