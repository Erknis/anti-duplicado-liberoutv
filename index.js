// =====================================================================
//  ANTI-TESTE-DUPLICADO — LiberouTV  (v4 — salva login/checkout do teste)
//  BotBot (botão "Já instalei") -> ESTA API -> painelblackbr
//
//  Estratégia: responde IMEDIATAMENTE pro BotBot (não trava) e chama o
//  painel por trás. Bloqueia número repetido. Guarda a lista de números
//  COM login, senha e link de checkout de cada teste gerado.
// =====================================================================

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT        = process.env.PORT || 3000;
const PAINEL_URL  = process.env.PAINEL_API_URL ||
                    "https://painelblackbr.site/api/chatbot/lKWOzMODzo/qK4WrkQ1eN";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "troque-este-token";
const DEDUP_DAYS  = parseInt(process.env.DEDUP_DAYS || "0", 10);
const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE     = path.join(DATA_DIR, "clientes.json"); // novo formato (rich)
const DB_FILE_OLD = path.join(DATA_DIR, "clientes.csv");  // formato antigo (migrado)
const PAUSA_FILE  = path.join(DATA_DIR, "pausas.json");   // estado + histórico de pausas
const HUMANOS_LOG = path.join(DATA_DIR, "humanos.json");  // log de pedidos de atendimento humano

// ---- BotBot (pra avisar humanos quando cliente pedir) ----
const BOTBOT_BASE   = process.env.BOTBOT_BASE || "https://botbot.chat";
const BOTBOT_APPKEY = process.env.BOTBOT_APPKEY || "20978e98-f860-40f7-bbd0-5d66b86afea8";
const BOTBOT_AUTHKEY= process.env.BOTBOT_AUTHKEY || "2NvnaUg2JqxYiUfYYwpNcoSQNJnWJE4itCVEiFSgeyQz9GX3lw";
// números que recebem o aviso (separar vários por vírgula)
const AVISO_HUMANOS = (process.env.AVISO_HUMANOS || "5535998877595,5553991836803")
  .split(",").map(s => String(s).replace(/\D/g, "")).filter(Boolean);

const MSG_GERANDO =
  "🎉 *Instalação confirmada!*\n\n⏳ Gerando seu TESTE GRÁTIS, aguarde alguns segundos...";
const MSG_SEM_NUMERO =
  "Não consegui identificar seu número. 😕 Digite *HUMANO* que um atendente te ajuda.";

// Link de venda usado quando o número é antigo (não tem checkout salvo)
const LINK_VENDA_PADRAO = process.env.LINK_VENDA ||
  "https://painelblackbr.site/#/checkout/241KARvDmx/VrW8PmVPWK";

// ---- mensagem quando a GERAÇÃO DE TESTES está PAUSADA ----
// Mostra pra TODO mundo que tentar gerar (antes de qualquer checagem).
function msgPausado(motivo) {
  const m = motivo && motivo.trim() ? motivo.trim() : "estamos em manutenção";
  return (
    "🚧 *Geração de testes temporariamente pausada.*\n\n" +
    "Desculpe pelo transtorno! 😊\n" +
    "Motivo: *" + m + "*\n\n" +
    "Em breve voltamos a liberar testes grátis. 🍿\n" +
    "Enquanto isso, digite *HUMANO* para falar com a nossa equipe. 👤"
  );
}

// ---- mensagem pro CLIENTE quando pede atendimento humano ----
const MSG_HUMANO_CLIENTE =
  "👤 *Atendimento humano solicitado!*\n\n" +
  "Já avisei a nossa equipe. 🙋\n" +
  "Um operador foi acionado e *logo irá falar com você aqui mesmo*. ⏳\n\n" +
  "Obrigado pela paciência! 🙏";

// ---- RENOVAÇÃO ----
// Cliente tem login/checkout salvos -> manda o link DELE (renovação com 1 clique)
function msgRenovacaoComLogin(dados) {
  return (
    "🔄 *Renovação do seu plano* 🔄\n\n" +
    "Encontramos seu cadastro! 🎉\n\n" +
    "👤 *Seu login:*\n" +
    "✅ Usuário: " + dados.username + "\n" +
    "✅ Senha: " + dados.password + "\n" +
    (dados.vence ? "⏳ Vence em: " + dados.vence + "\n" : "") +
    "\n💳 *Renove aqui (ativação automática):*\n" + dados.payUrl + "\n\n" +
    "Assim que o pagamento cair, seu acesso é renovado na hora! 🚀\n" +
    "Precisa de ajuda? Digite *HUMANO*. 👤"
  );
}

// Cliente existe no banco mas sem checkout salvo (cadastro antigo)
function msgRenovacaoSemCheckout() {
  return (
    "🔄 *Renovação do seu plano* 🔄\n\n" +
    "Identificamos seu número! 😊\n" +
    "Para renovar seu acesso agora mesmo:\n\n" +
    "💳 *Pague em 1 minuto:*\n" + LINK_VENDA_PADRAO + "\n\n" +
    "Assim que o pagamento cair, seu acesso é liberado na hora! 🚀\n" +
    "Prefere falar com a equipe? Digite *HUMANO*. 👤"
  );
}

// Cliente NÃO encontrado no banco (número desconhecido)
function msgRenovacaoNaoEncontrado() {
  return (
    "🤔 *Não encontrei seu cadastro*\n\n" +
    "Não localizei um teste ativo pra esse número. 😕\n\n" +
    "Mas tudo bem! Você pode:\n" +
    "✨ Gerar um *novo teste grátis* (digite a opção de teste)\n\n" +
    "Ou *HUMANO* pra falar com a nossa equipe. 👤"
  );
}

// ---- envia aviso pros números humanos via BotBot ----
// Limpa o "motivo": se vier "Seleção da Lista: <uuid>" do BotBot, troca por algo legível.
function limparMotivo(motivo, telefoneCliente) {
  const m = String(motivo || "").trim();
  if (!m) return "";
  // BotBot registra clique em menu como "Seleção da Lista: <uuid>" -> não é útil
  if (/^sele[cç][aã]o da lista/i.test(m)) return "";
  return m;
}

// texto do aviso que vai pro(s) número(es) de atendimento
function msgAvisoHumano(telefoneCliente, nomeCliente, motivo) {
  const motivoLimpo = limparMotivo(motivo, telefoneCliente);
  let s = "🚨 *PEDIDO DE ATENDIMENTO HUMANO* 🚨\n\n";
  s += "📞 Cliente: " + telefoneCliente;
  if (nomeCliente) s += " (" + nomeCliente + ")";
  s += "\n";
  if (motivoLimpo) {
    s += "📝 Motivo: " + motivoLimpo + "\n";
  } else {
    s += "📝 O cliente pediu pra falar com um atendente pelo menu.\n";
  }
  s += "\n👉 Falar com o cliente pelo WhatsApp:\n";
  s += "https://wa.me/" + telefoneCliente;
  return s;
}

async function avisarHumanos(telefoneCliente, nomeCliente, motivo) {
  const texto = msgAvisoHumano(telefoneCliente, nomeCliente, motivo);
  const resultados = [];
  for (const num of AVISO_HUMANOS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(`${BOTBOT_BASE}/api/v2/sendText`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "appKey": BOTBOT_APPKEY,
          "authKey": BOTBOT_AUTHKEY,
        },
        body: JSON.stringify({ to: num, message: texto }),
        signal: ctrl.signal,
      });
      const body = await r.text();
      console.log(`[humano] aviso -> ${num} status=${r.status} resp=${(body || "").slice(0, 200)}`);
      resultados.push({ numero: num, status: r.status, ok: r.status >= 200 && r.status < 300, resp: (body || "").slice(0, 200) });
    } catch (e) {
      console.error(`[humano] erro avisando ${num}:`, e.message);
      resultados.push({ numero: num, status: 0, ok: false, resp: String(e) });
    } finally {
      clearTimeout(timer);
    }
  }
  return resultados;
}

// ---- mensagem quando o número JÁ testou (negado) -> leva pra venda ----
// Se tiver dados do teste salvo (login + checkout), usa eles. Senão, genérico.
function msgJaTestou(dados) {
  if (dados && dados.username && dados.payUrl) {
    return (
      "⚠️ *Esse número já usou o teste grátis!* 😊\n\n" +
      "Mas calma — seu acesso já está quase pronto! 😍\n" +
      "É só pagar que o sistema *ativa sozinho, na hora*. 🍿🔥\n\n" +
      "👤 *Seu login já está criado:*\n" +
      `✅ Usuário: ${dados.username}\n` +
      `✅ Senha: ${dados.password}\n\n` +
      "💳 *Pague aqui (ativação automática):*\n" + dados.payUrl + "\n\n" +
      "Assim que o pagamento cair, é só abrir o app e assistir! 🚀\n" +
      "Ou digite *HUMANO* para falar com a nossa equipe. 👤"
    );
  }
  const link = (dados && dados.payUrl) || LINK_VENDA_PADRAO;
  return (
    "⚠️ *Esse número já usou o teste grátis!* 😊\n\n" +
    "Mas não precisa parar por aqui — dá pra continuar assistindo *sem travamentos*, " +
    "com tudo liberado, agora mesmo. 🍿🔥\n\n" +
    "💳 *Assine em 1 minuto:*\n" + link + "\n\n" +
    "Assim que o pagamento cair, seu acesso é liberado na hora! 🚀\n" +
    "Ou digite *HUMANO* para falar com a nossa equipe. 👤"
  );
}

// ---- mensagem do teste aprovado (personalizada) ----
function msgTesteAprovado(d) {
  const u = d.username, p = d.password, dns = d.dns;
  const m3u = `${dns}/get.php?username=${u}&password=${p}&type=m3u_plus&output=mpegts`;
  return (
"📺 *SEJA BEM-VINDO A LIBEROU TV !*\n" +
`✅ Usuário: ${u}\n` +
`✅ Senha: ${p}\n` +
`📦 Plano: ${d.package}\n` +
`⏳ Vence: ${d.expiresAtFormatted}\n` +
`📶 Conexões: ${d.connections}\n` +
`🌎 DNS: ${dns}\n` +
"📥 M3U:\n" + m3u + "\n" +
`💳 Renovar: ${d.payUrl}\n` +
"⭐ *APPS PARCEIROS:*\n" +
"▪ *VIZZION PLAY* (Samsung, LG, Roku, Android)\n" +
"  Código: 701266\n" +
`  User: ${u} | Senha: ${p}\n` +
"▪ *ASSIST+* (Samsung, LG, Roku, Android)\n" +
"  Código: 926692\n" +
`  User: ${u} | Senha: ${p}\n` +
"▪ *EPICPLAY* (Samsung, LG, Roku, Android)\n" +
"  Código: 456642\n" +
`  User: ${u} | Senha: ${p}\n` +
"▪ *MAGIC PLAYER* (Roku, LG, Android)\n" +
"  Código: 926692\n" +
`  User: ${u} | Senha: ${p}\n` +
"▪ *ZINK* (Playstore, Fire TV, Roku)\n" +
`  User: ${u} | Senha: ${p}\n` +
"▪ *PLAYER OTT* (Playstore, Roku)\n" +
`  User: ${u} | Senha: ${p}\n` +
"▪ *UNI TV* (Android)\n" +
"  Downloader: 9387398\n" +
" *LIBEROU TV®️*"
  );
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// registro: Map telefone -> { data, username, password, payUrl, dns, pacote, conexoes, vence }
const registro = new Map();
function soDigitos(v) { return String(v == null ? "" : v).replace(/\D/g, ""); }

// ===================== ESTADO DE PAUSA =====================
// pausa = { ativa: bool, motivo: string, desde: ms|null, historico: [{motivo, inicio, fim, duracao}] }
let pausa = { ativa: false, motivo: "", desde: null, historico: [] };
(function carregarPausa() {
  if (!fs.existsSync(PAUSA_FILE)) {
    console.log("[init] pausa: desativada.");
    return;
  }
  try {
    const j = JSON.parse(fs.readFileSync(PAUSA_FILE, "utf8"));
    pausa = {
      ativa: !!j.ativa,
      motivo: j.motivo || "",
      desde: j.desde || null,
      historico: Array.isArray(j.historico) ? j.historico : [],
    };
    console.log(`[init] pausa: ${pausa.ativa ? "ATIVADA" : "desativada"} (${pausa.historico.length} registros no histórico).`);
  } catch (e) {
    console.error("[init] erro lendo pausas.json:", e.message);
  }
})();
function salvarPausa() {
  fs.writeFileSync(PAUSA_FILE, JSON.stringify(pausa, null, 2));
}
function pausar(motivo) {
  pausa.ativa = true;
  pausa.motivo = (motivo || "").trim();
  pausa.desde = Date.now();
  salvarPausa();
  console.log(`[pausa] ATIVADA — motivo: "${pausa.motivo}"`);
}
function reativar() {
  if (!pausa.ativa) return;
  const fim = Date.now();
  const inicio = pausa.desde || fim;
  const duracaoMin = Math.round((fim - inicio) / 60000);
  pausa.historico.unshift({ motivo: pausa.motivo, inicio, fim, duracaoMin });
  if (pausa.historico.length > 100) pausa.historico.pop();
  pausa.ativa = false;
  pausa.motivo = "";
  pausa.desde = null;
  salvarPausa();
  console.log("[pausa] REATIVADA — geração de testes voltou ao normal.");
}

// ===================== LOG DE PEDIDOS HUMANOS =====================
// [{ quando, telefone, nome, motivo, avisosEnviados, avisosOk }]
let humanosLog = [];
(function carregarHumanos() {
  if (!fs.existsSync(HUMANOS_LOG)) {
    console.log("[init] log de humanos: vazio.");
    return;
  }
  try {
    const j = JSON.parse(fs.readFileSync(HUMANOS_LOG, "utf8"));
    humanosLog = Array.isArray(j) ? j : [];
    console.log(`[init] log de humanos: ${humanosLog.length} registros.`);
  } catch (e) { console.error("[init] erro lendo humanos.json:", e.message); }
})();
function salvarHumanos() { fs.writeFileSync(HUMANOS_LOG, JSON.stringify(humanosLog, null, 2)); }
// =================================================================
// =========================================================

function salvarArquivo() {
  const arr = [...registro.entries()].map(([tel, d]) => ({ telefone: tel, ...d }));
  fs.writeFileSync(DB_FILE, JSON.stringify(arr, null, 2));
}

(function carregar() {
  // 1) lê o novo formato (clientes.json), se existir
  if (fs.existsSync(DB_FILE)) {
    try {
      const arr = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      for (const it of arr || []) {
        const t = soDigitos(it.telefone);
        if (!t) continue;
        registro.set(t, {
          data: it.data || Date.now(),
          username: it.username || "",
          password: it.password || "",
          payUrl: it.payUrl || "",
          dns: it.dns || "",
          pacote: it.pacote || "",
          conexoes: it.conexoes || "",
          vence: it.vence || "",
        });
      }
    } catch (e) { console.error("[init] erro lendo json:", e.message); }
  }
  // 2) migração: se existir clientes.csv antigo, importa (sem login, só bloqueio)
  if (fs.existsSync(DB_FILE_OLD)) {
    let migrados = 0;
    const linhas = fs.readFileSync(DB_FILE_OLD, "utf8").split("\n");
    for (const ln of linhas) {
      const [tel, iso] = ln.split(",");
      const t = soDigitos(tel);
      if (t && !registro.has(t)) {
        registro.set(t, {
          data: Date.parse(iso) || Date.now(),
          username: "", password: "", payUrl: "", dns: "", pacote: "", conexoes: "", vence: "",
        });
        migrados++;
      }
    }
    if (migrados > 0) {
      console.log(`[init] ${migrados} numeros migrados do CSV antigo.`);
      salvarArquivo();
    }
  }
  console.log(`[init] ${registro.size} numeros carregados.`);
})();

function jaBloqueado(telefone) {
  if (!registro.has(telefone)) return false;
  if (DEDUP_DAYS <= 0) return true;
  const dias = (Date.now() - registro.get(telefone).data) / (1000 * 60 * 60 * 24);
  return dias < DEDUP_DAYS;
}
function gravar(telefone, dados) {
  const agora = Date.now();
  registro.set(telefone, { data: agora, ...(dados || {}) });
  salvarArquivo();
}

const painelLog = [];
async function gerarTesteNoPainel(rawBody, contentType) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    // repassa pro painel o MESMO pacote que o BotBot mandou (com senderPhone etc.)
    const r = await fetch(PAINEL_URL, {
      method: "POST",
      headers: { "Content-Type": contentType || "application/json" },
      body: rawBody && rawBody.length ? rawBody : "{}",
      signal: ctrl.signal,
    });
    const body = await r.text();
    painelLog.unshift({ quando: new Date().toISOString(), status: r.status, resp: (body || "").slice(0, 800) });
    if (painelLog.length > 15) painelLog.pop();
    console.log(`[painel] status=${r.status} resp=${(body || "").slice(0, 300)}`);
    return { status: r.status, body: body || "" };
  } catch (e) {
    painelLog.unshift({ quando: new Date().toISOString(), status: "ERRO", resp: String(e) });
    console.error("[painel] erro:", e.message);
    return { status: 0, body: "" };
  } finally {
    clearTimeout(timer);
  }
}

const ultimas = [];
function logReq(req, extra) {
  const item = {
    quando: new Date().toISOString(),
    metodo: req.method,
    path: req.path,
    contentType: req.headers["content-type"] || "",
    query: req.query,
    body: req.body,
    raw: (req.rawBody || "").slice(0, 500),
    extra: extra || "",
  };
  ultimas.unshift(item);
  if (ultimas.length > 20) ultimas.pop();
  console.log("[req]", JSON.stringify(item));
}

function extrairTelefone(req) {
  const b = req.body || {}, q = req.query || {};
  let t = b.senderPhone || b.telefone || b.phone || b.numero || b.number || b.from ||
          b.contato || b.sender || b.celular ||
          q.senderPhone || q.telefone || q.phone || q.numero || q.number ||
          q.from || q.contato || q.sender || q.celular || "";
  if (!t && req.rawBody) {
    const m = String(req.rawBody).match(/\d[\d\s().-]{7,}/);
    if (m) t = m[0];
  }
  return soDigitos(t);
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="pt-br"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Liberou TV — Painel de Testes</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
body{background:#0f1117;color:#e7e9ee;min-height:100vh}
.wrap{max-width:1100px;margin:0 auto;padding:20px}
h1{font-size:22px;display:flex;align-items:center;gap:10px;margin-bottom:4px}
.sub{color:#8b90a0;font-size:13px;margin-bottom:20px}
.card{background:#171a23;border:1px solid #242938;border-radius:14px;padding:18px}
.login{max-width:380px;margin:60px auto}
.login input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #2c3142;background:#0f1117;color:#fff;font-size:15px;margin:10px 0}
button{cursor:pointer;border:none;border-radius:10px;font-size:14px;font-weight:600;padding:11px 16px}
.btn{background:#3b82f6;color:#fff;width:100%}
.btn:hover{background:#2f6fd6}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:18px}
.stat{background:#171a23;border:1px solid #242938;border-radius:12px;padding:14px}
.stat .n{font-size:26px;font-weight:700}
.stat .l{color:#8b90a0;font-size:12px;margin-top:2px}
.pausa-card{background:#171a23;border:1px solid #242938;border-radius:14px;padding:18px;margin-bottom:18px}
.pausa-card.ativa{border-color:#ef4444;background:linear-gradient(180deg,#1c1213,#171a23)}
.pausa-head{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.pausa-badge{font-size:13px;font-weight:700;padding:5px 12px;border-radius:20px}
.pausa-badge.on{background:#ef4444;color:#fff;animation:pulse 1.8s infinite}
.pausa-badge.off{background:#16241c;color:#34d399}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}
.pausa-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:8px}
.pausa-row input{flex:1;min-width:200px;padding:10px 12px;border-radius:10px;border:1px solid #2c3142;background:#0f1117;color:#fff}
.pausa-motivo-atual{color:#f87171;font-size:13px;margin-top:6px}
.pausa-desde{color:#8b90a0;font-size:12px;margin-top:2px}
.hist-head{display:flex;align-items:center;justify-content:space-between;margin:18px 0 10px}
.hist-head h2{font-size:16px}
.hist-empty{color:#5b6072;font-size:13px;padding:10px 0}
.hist-item{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid #242938;font-size:13px;flex-wrap:wrap}
.hist-item .dot{width:8px;height:8px;border-radius:50%;background:#ef4444;margin-top:6px;flex-shrink:0}
.hist-item .info{flex:1;min-width:200px}
.hist-item .mt{color:#e7e9ee;font-weight:600}
.hist-item .mt span{color:#8b90a0;font-weight:400}
.hist-item .meta{color:#8b90a0;font-size:12px}
.toolbar{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.toolbar input{flex:1;min-width:160px;padding:10px 12px;border-radius:10px;border:1px solid #2c3142;background:#0f1117;color:#fff}
.mini{padding:9px 12px;font-size:13px}
.gray{background:#2c3142;color:#e7e9ee}.gray:hover{background:#363c50}
.red{background:#ef4444;color:#fff}.red:hover{background:#d83a3a}
.copiar{background:#2563eb;color:#fff}.copiar:hover{background:#1d4fd0}
.pausar-btn{background:#f59e0b;color:#1a1206}.pausar-btn:hover{background:#d97f06}
.reativar-btn{background:#22c55e;color:#04210f}.reativar-btn:hover{background:#1bb14e}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:11px 10px;border-bottom:1px solid #242938;font-size:14px;vertical-align:top}
th{color:#8b90a0;font-weight:600;font-size:12px;text-transform:uppercase}
td.num{font-variant-numeric:tabular-nums;font-weight:600}
.ha-dias{color:#60a5fa;font-weight:700;font-size:13px}
.dt-full{color:#8b90a0;font-size:11px;margin-top:2px}
.cred{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;background:#0f1117;padding:3px 6px;border-radius:6px;display:inline-block;margin:1px 0;cursor:pointer}
.cred:hover{background:#1f2533}
.semlogin{color:#5b6072;font-style:italic;font-size:12px}
.act{display:flex;gap:6px;flex-wrap:wrap}
.act a,.act button{font-size:12px;padding:6px 10px;border-radius:8px;text-decoration:none}
.wa{background:#0b3b2e;color:#34d399;display:inline-flex;align-items:center}
.ck{background:#7c2d12;color:#fdba74}
.empty{text-align:center;color:#8b90a0;padding:30px}
.err{color:#f87171;font-size:13px;margin-top:6px;min-height:16px}
.foot{color:#5b6072;font-size:12px;text-align:center;margin-top:20px}
@media(max-width:720px){.stats{grid-template-columns:1fr 1fr}.hide-sm{display:none}td{font-size:12px}}
</style></head><body>
<div class="wrap">
  <div id="login" class="login card">
    <h1>📺 Liberou TV</h1>
    <div class="sub">Painel de Testes — acesso restrito</div>
    <input id="tk" type="password" placeholder="Digite seu token de acesso" />
    <button class="btn" onclick="entrar()">Entrar</button>
    <div id="loginerr" class="err"></div>
  </div>

  <div id="app" style="display:none">
    <h1>📺 Liberou TV <span style="font-size:13px;color:#8b90a0;font-weight:400">/ Painel de Testes</span></h1>
    <div class="sub">Números que já geraram teste grátis · clique no login/senha pra copiar</div>
    <div class="stats">
      <div class="stat"><div class="n" id="s-total">0</div><div class="l">Total cadastrados</div></div>
      <div class="stat"><div class="n" id="s-hoje">0</div><div class="l">Testaram hoje</div></div>
      <div class="stat"><div class="n" id="s-bloq">—</div><div class="l">Bloqueio</div></div>
    </div>

    <!-- CARD DE PAUSA DA GERAÇÃO DE TESTES -->
    <div id="pausa-card" class="pausa-card">
      <div class="pausa-head">
        <span style="font-size:17px;font-weight:700">🚧 Geração de Testes</span>
        <span id="pausa-badge" class="pausa-badge off">CARREGANDO...</span>
      </div>
      <div id="pausa-motivo-atual" class="pausa-motivo-atual" style="display:none"></div>
      <div id="pausa-desde" class="pausa-desde" style="display:none"></div>
      <div class="pausa-row" id="pausa-form">
        <input id="pausa-motivo" type="text" placeholder="Motivo da pausa (ex: manutenção no servidor, estoque, etc.)" />
        <button class="mini pausar-btn" id="btn-pausar" onclick="pausarNow()">⏸ Pausar geração</button>
        <button class="mini reativar-btn" id="btn-reativar" onclick="reativarNow()" style="display:none">▶ Reativar geração</button>
      </div>
    </div>

    <!-- HISTÓRICO DE PAUSAS -->
    <div class="hist-head">
      <h2>📜 Histórico de pausas</h2>
      <button class="mini gray" onclick="carregarEstado()">↻ Atualizar</button>
    </div>
    <div id="historico" class="card" style="padding:6px 14px"><div class="hist-empty">Carregando...</div></div>

    <!-- PEDIDOS DE ATENDIMENTO HUMANO -->
    <div class="hist-head">
      <h2>👤 Pedidos de atendimento humano</h2>
      <div>
        <button class="mini gray" onclick="carregarHumanos()">↻ Atualizar</button>
        <button class="mini red" onclick="limparHumanos()">Limpar</button>
      </div>
    </div>
    <div class="stats" style="margin-bottom:12px">
      <div class="stat"><div class="n" id="h-total">0</div><div class="l">Total de pedidos</div></div>
      <div class="stat"><div class="n" id="h-hoje">0</div><div class="l">Pedidos hoje</div></div>
    </div>
    <div id="humanos" class="card" style="padding:6px 14px"><div class="hist-empty">Carregando...</div></div>
    <div class="card">
      <div class="toolbar">
        <input id="busca" placeholder="🔎 Buscar número..." oninput="render()" />
        <button class="mini gray" onclick="carregar()">↻ Atualizar</button>
        <button class="mini gray" onclick="baixarCSV()">⬇ CSV</button>
        <button class="mini red" onclick="limparTudo()">Liberar todos</button>
      </div>
      <div id="tabela"></div>
    </div>
    <div class="foot">Liberou TV · clique em qualquer campo de login/senha pra copiar · sair fechando a aba</div>
  </div>
</div>
<script>
var TK="", DADOS=[];
function q(s){return encodeURIComponent(s)}
function entrar(){
  TK=document.getElementById("tk").value.trim();
  if(!TK){return}
  fetch("/api/numeros?token="+q(TK)).then(function(r){
    if(r.status===401){document.getElementById("loginerr").textContent="Token inválido.";return null}
    return r.json();
  }).then(function(j){
    if(!j)return;
    sessionStorage.setItem("tk",TK);
    document.getElementById("login").style.display="none";
    document.getElementById("app").style.display="block";
    aplicar(j);
    carregarEstado();
    carregarHumanos();
  }).catch(function(){document.getElementById("loginerr").textContent="Erro de conexão."});
}
function carregar(){
  fetch("/api/numeros?token="+q(TK)).then(function(r){return r.json()}).then(aplicar);
}
// ===== PAUSA =====
function carregarEstado(){
  fetch("/api/estado?token="+q(TK)).then(function(r){return r.json()}).then(aplicarEstado);
  fetch("/api/historico?token="+q(TK)).then(function(r){return r.json()}).then(aplicarHist);
}
function aplicarEstado(j){
  var card=document.getElementById("pausa-card");
  var badge=document.getElementById("pausa-badge");
  var dvMotivo=document.getElementById("pausa-motivo-atual");
  var dvDesde=document.getElementById("pausa-desde");
  var btnP=document.getElementById("btn-pausar");
  var btnR=document.getElementById("btn-reativar");
  var inM=document.getElementById("pausa-motivo");
  if(j.ativa){
    card.classList.add("ativa");
    badge.className="pausa-badge on";
    badge.textContent="PAUSADA";
    dvMotivo.style.display="block";
    dvMotivo.textContent="Motivo: "+(j.motivo||"—");
    dvDesde.style.display="block";
    dvDesde.textContent="Desde: "+(j.desde?fmt(j.desde):"—");
    btnP.style.display="none";
    btnR.style.display="inline-block";
    inM.style.display="none";
  }else{
    card.classList.remove("ativa");
    badge.className="pausa-badge off";
    badge.textContent="ATIVA";
    dvMotivo.style.display="none";
    dvDesde.style.display="none";
    btnP.style.display="inline-block";
    btnR.style.display="none";
    inM.style.display="inline-block";
  }
}
function aplicarHist(j){
  var box=document.getElementById("historico");
  var h=j.historico||[];
  if(!h.length){box.innerHTML='<div class="hist-empty">Nenhuma pausa registrada ainda. 🟢</div>';return}
  var html="";
  h.forEach(function(x){
    html+='<div class="hist-item"><div class="dot"></div><div class="info">'+
      '<div class="mt">'+esc(x.motivo||"—")+' <span>· '+x.duracaoMin+' min</span></div>'+
      '<div class="meta">Início: '+fmt(x.inicio)+(x.fim?' · Fim: '+fmt(x.fim):" (em andamento)")+'</div>'+
      '</div></div>';
  });
  box.innerHTML=html;
}
// ===== HUMANOS =====
function carregarHumanos(){
  fetch("/api/humanos?token="+q(TK)).then(function(r){return r.json()}).then(aplicarHumanos);
}
function aplicarHumanos(j){
  document.getElementById("h-total").textContent=j.total||0;
  document.getElementById("h-hoje").textContent=j.hoje||0;
  var box=document.getElementById("humanos");
  var lista=j.lista||[];
  if(!lista.length){box.innerHTML='<div class="hist-empty">Nenhum pedido de atendimento ainda. 🟢</div>';return}
  var html="";
  lista.forEach(function(x){
    var statusAviso = x.avisosEnviados>0
      ? (x.avisosOk+'/'+x.avisosEnviados+' avisos OK ✓')
      : 'sem aviso';
    html+='<div class="hist-item"><div class="dot" style="background:#3b82f6"></div><div class="info">'+
      '<div class="mt">'+esc(x.telefone)+(x.nome?' <span>· '+esc(x.nome)+'</span>':'')+'</div>'+
      (x.motivo?'<div class="meta">Motivo: '+esc(x.motivo)+'</div>':'')+
      '<div class="meta">'+fmt(x.quando)+' · '+statusAviso+'</div>'+
      '</div><div><a class="wa" target="_blank" href="https://wa.me/'+esc(x.telefone)+'">WhatsApp</a></div></div>';
  });
  box.innerHTML=html;
}
function limparHumanos(){
  if(!confirm("Limpar TODO o histórico de pedidos de atendimento humano?"))return;
  fetch("/api/humanos/limpar?token="+q(TK),{method:"POST"}).then(function(){carregarHumanos()});
}
function pausarNow(){
  var m=document.getElementById("pausa-motivo").value.trim();
  if(!m){m=prompt("Qual o motivo da pausa?");if(m==null)return}
  if(!confirm("Pausar a geração de testes?\\nMotivo: "+m))return;
  fetch("/api/pausar?token="+q(TK)+"&motivo="+q(m)).then(function(){carregarEstado()});
}
function reativarNow(){
  if(!confirm("Reativar a geração de testes?\\n(Os números que já testaram continuam bloqueados.)"))return;
  fetch("/api/reativar?token="+q(TK),{method:"POST"}).then(function(){carregarEstado()});
}
function aplicar(j){
  DADOS=j.lista||[];
  document.getElementById("s-total").textContent=j.total||0;
  document.getElementById("s-bloq").textContent=j.dedupDays>0?(j.dedupDays+" dias"):"Permanente";
  var hoje=new Date().toDateString();
  document.getElementById("s-hoje").textContent=DADOS.filter(function(x){return new Date(x.data).toDateString()===hoje}).length;
  render();
}
function fmt(ts){var d=new Date(ts);return d.toLocaleString("pt-BR")}
function haDias(ts){
  var diff=Date.now()-ts;
  if(diff<0)diff=0;
  var min=Math.floor(diff/60000);
  var hor=Math.floor(diff/3600000);
  var dia=Math.floor(diff/86400000);
  if(dia>=1)return "há "+dia+(dia===1?" dia":" dias");
  if(hor>=1)return "há "+hor+(hor===1?" hora":" horas");
  if(min>=1)return "há "+min+(min===1?" minuto":" minutos");
  return "agora mesmo";
}
function copiar(txt){
  navigator.clipboard.writeText(txt).then(function(){
    var n=document.getElementById("toast");if(!n)return;
    n.textContent="Copiado: "+txt;n.style.opacity="1";
    setTimeout(function(){n.style.opacity="0"},1400);
  });
}
function render(){
  var f=(document.getElementById("busca").value||"").replace(/\\D/g,"");
  var lista=DADOS.filter(function(x){return !f||x.telefone.indexOf(f)>=0});
  if(!lista.length){document.getElementById("tabela").innerHTML='<div class="empty">Nenhum número encontrado.</div>';return}
  var h='<table><thead><tr><th>#</th><th>Número</th><th class="hide-sm">Login / Senha</th><th class="hide-sm">Bloqueado há</th><th>Ações</th></tr></thead><tbody>';
  lista.forEach(function(x,i){
    var loginHtml;
    if(x.username){
      loginHtml='<span class="cred" title="copiar usuário" onclick="copiar(\\''+esc(x.username)+'\\')">👤 '+esc(x.username)+'</span><br>'+
                '<span class="cred" title="copiar senha" onclick="copiar(\\''+esc(x.password)+'\\')">🔑 '+esc(x.password)+'</span>';
    }else{
      loginHtml='<span class="semlogin">(sem login salvo)</span>';
    }
    var ckHtml = x.payUrl?'<a class="ck" target="_blank" href="'+esc(x.payUrl)+'">💳 Checkout</a>':'';
    h+='<tr><td>'+(i+1)+'</td><td class="num">'+esc(x.telefone)+'</td>'+
       '<td class="hide-sm">'+loginHtml+'</td>'+
       '<td class="hide-sm"><div class="ha-dias">'+haDias(x.data)+'</div><div class="dt-full">'+fmt(x.data)+'</div></td>'+
       '<td><div class="act">'+
       '<a class="wa" target="_blank" href="https://wa.me/'+esc(x.telefone)+'">WhatsApp</a>'+
       ckHtml+
       '<button class="red" onclick="apagar(\\''+esc(x.telefone)+'\\')">Apagar</button>'+
       '</div></td></tr>';
  });
  h+='</tbody></table>';
  document.getElementById("tabela").innerHTML=h;
}
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}
function apagar(tel){
  if(!confirm("Liberar o número "+tel+" para gerar teste de novo?"))return;
  fetch("/apagar?token="+q(TK)+"&telefone="+q(tel)).then(function(){carregar()});
}
function limparTudo(){
  if(!confirm("ATENÇÃO: isso libera TODOS os números (todos poderão testar de novo). Continuar?"))return;
  fetch("/api/limpar?token="+q(TK)).then(function(){carregar()});
}
function baixarCSV(){
  var linhas=["telefone,usuario,senha,checkout,data"];
  DADOS.forEach(function(x){linhas.push([x.telefone,x.username,x.password,x.payUrl,fmt(x.data)].map(function(v){return '"'+String(v==null?"":v).replace(/"/g,'""')+'"'}).join(","))});
  var blob=new Blob([linhas.join("\\n")],{type:"text/csv"});
  var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="numeros_liberoutv.csv";a.click();
}
(function(){var t=sessionStorage.getItem("tk");if(t){document.getElementById("tk").value=t;entrar()}})();
</script>
</body></html>`;

const app = express();
const captureRaw = (req, _res, buf) => { req.rawBody = buf.toString(); };
app.use(express.json({ verify: captureRaw }));
app.use(express.urlencoded({ extended: true, verify: captureRaw }));

function texto(res, s) { res.set("Content-Type", "text/plain; charset=utf-8").send(s); }

// Resposta pro BotBot: ele lê a mensagem do campo "reply" (JSON).
function responderBotBot(res, s) { res.json({ reply: s }); }

async function handleTeste(req, res) {
  logReq(req);
  const telefone = extrairTelefone(req);

  // PAUSA ATIVA? -> mostra msg de manutenção pra TODO mundo e NÃO gera teste
  if (pausa.ativa) return responderBotBot(res, msgPausado(pausa.motivo));

  if (!telefone) return responderBotBot(res, MSG_SEM_NUMERO);

  // JÁ TESTOU -> mensagem de venda com o LOGIN e CHECKOUT salvos (se houver)
  if (jaBloqueado(telefone)) return responderBotBot(res, msgJaTestou(registro.get(telefone)));

  // número novo -> chama o painel e monta a mensagem personalizada
  const r = await gerarTesteNoPainel(req.rawBody, req.headers["content-type"]);
  let d = null;
  try { d = JSON.parse(r.body); } catch (e) {}

  if (d && d.username && d.password) {
    // SALVA login, senha e checkout junto do número (pra reenviar na próxima vez)
    gravar(telefone, {
      username: d.username,
      password: d.password,
      payUrl: d.payUrl || "",
      dns: d.dns || "",
      pacote: d.package || "",
      conexoes: d.connections || "",
      vence: d.expiresAtFormatted || "",
    });
    return responderBotBot(res, msgTesteAprovado(d));
  }

  // painel não retornou um teste válido -> NÃO bloqueia (deixa tentar de novo)
  return responderBotBot(res, MSG_GERANDO);
}
app.post("/teste", handleTeste);
app.get("/teste", handleTeste);

// ---- endpoint de ATENDIMENTO HUMANO ----
// Dispara aviso pros números de atendimento via BotBot e responde pro cliente.
async function handleHumano(req, res) {
  logReq(req, "ATENDIMENTO HUMANO");
  const telefone = extrairTelefone(req);
  const b = req.body || {}, q = req.query || {};
  const nome = b.senderName || q.senderName || "";
  const motivoRaw = b.senderMessage || b.motivo || q.motivo || "";
  const motivo = limparMotivo(motivoRaw, telefone);

  if (!telefone) return responderBotBot(res, "Não consegui identificar seu número. 😕 Tente novamente.");

  // dispara aviso pros humanos (não bloqueia a resposta pro cliente)
  let avisos = [];
  try {
    avisos = await avisarHumanos(telefone, nome, motivo);
  } catch (e) {
    console.error("[humano] erro geral:", e.message);
  }

  // registra no log
  const okCount = (avisos || []).filter(a => a.ok).length;
  humanosLog.unshift({
    quando: Date.now(),
    telefone,
    nome: nome || "",
    motivo: motivo || "",
    avisosEnviados: (avisos || []).length,
    avisosOk: okCount,
  });
  if (humanosLog.length > 200) humanosLog.pop();
  salvarHumanos();

  console.log(`[humano] pedido registrado: ${telefone} | avisos OK: ${okCount}/${(avisos || []).length}`);
  return responderBotBot(res, MSG_HUMANO_CLIENTE);
}
app.post("/humano", handleHumano);
app.get("/humano", handleHumano);

// ---- endpoint de RENOVAÇÃO ----
// Busca o número no banco e devolve o link de checkout DELE (renovação com 1 clique).
async function handleRenovar(req, res) {
  logReq(req, "RENOVACAO");
  const telefone = extrairTelefone(req);
  if (!telefone) return responderBotBot(res, MSG_SEM_NUMERO);

  const dados = registro.get(telefone);

  // Cliente encontrado E com login + checkout salvos -> link DELE
  if (dados && dados.username && dados.payUrl) {
    console.log(`[renovar] ${telefone}: encontrou login + checkout`);
    return responderBotBot(res, msgRenovacaoComLogin(dados));
  }

  // Cliente existe mas é antigo (sem login salvo) -> link de venda padrão
  if (dados) {
    console.log(`[renovar] ${telefone}: cadastro antigo sem checkout, link genérico`);
    return responderBotBot(res, msgRenovacaoSemCheckout());
  }

  // Cliente não encontrado -> sugere novo teste ou humano
  console.log(`[renovar] ${telefone}: não encontrado`);
  return responderBotBot(res, msgRenovacaoNaoEncontrado());
}
app.post("/renovar", handleRenovar);
app.get("/renovar", handleRenovar);

app.get("/debug", (_req, res) => {
  texto(res,
    "== ULTIMAS CHAMADAS DO BOTBOT ==\n\n" +
    ultimas.map(u => JSON.stringify(u, null, 2)).join("\n\n") +
    "\n\n\n== ULTIMAS RESPOSTAS DO PAINEL ==\n\n" +
    painelLog.map(u => JSON.stringify(u, null, 2)).join("\n\n"));
});

app.get("/numeros", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).send("Token invalido.");
  const lista = [...registro.entries()].map(([t, d]) => {
    const login = d.username ? `${d.username} / ${d.password}` : "(sem login)";
    const ck = d.payUrl ? ` | checkout: ${d.payUrl}` : "";
    return `${t} - ${new Date(d.data).toLocaleString("pt-BR")} | ${login}${ck}`;
  });
  texto(res, `Total: ${lista.length}\n\n${lista.join("\n")}`);
});

app.get("/apagar", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).send("Token invalido.");
  const tel = soDigitos(req.query.telefone);
  if (!tel || !registro.has(tel)) return texto(res, "Numero nao encontrado.");
  registro.delete(tel);
  salvarArquivo();
  texto(res, `Numero ${tel} liberado. OK`);
});

// ---- endpoints JSON para o painel visual ----
app.get("/api/numeros", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "token" });
  const lista = [...registro.entries()]
    .map(([tel, d]) => ({ telefone: tel, ...d }))
    .sort((a, b) => b.data - a.data);
  res.json({ total: lista.length, dedupDays: DEDUP_DAYS, lista });
});

app.get("/api/limpar", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "token" });
  registro.clear();
  salvarArquivo();
  res.json({ ok: true });
});

// ---- endpoints de PAUSA da geração de testes ----

// Estado atual: { ativa, motivo, desde, totalHistorico }
app.get("/api/estado", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "token" });
  res.json({
    ativa: pausa.ativa,
    motivo: pausa.motivo,
    desde: pausa.desde,
    totalHistorico: pausa.historico.length,
  });
});

// Pausar: POST com { motivo } ou GET ?motivo=
app.post("/api/pausar", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "token" });
  const motivo = (req.body && (req.body.motivo || req.query.motivo)) || req.query.motivo || "Sem motivo informado";
  pausar(motivo);
  res.json({ ok: true, ativa: true, motivo: pausa.motivo, desde: pausa.desde });
});
app.get("/api/pausar", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "token" });
  const motivo = req.query.motivo || "Sem motivo informado";
  pausar(motivo);
  res.json({ ok: true, ativa: true, motivo: pausa.motivo, desde: pausa.desde });
});

// Reativar: volta ao normal (números já testados continuam bloqueados)
app.post("/api/reativar", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "token" });
  reativar();
  res.json({ ok: true, ativa: false });
});
app.get("/api/reativar", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "token" });
  reativar();
  res.json({ ok: true, ativa: false });
});

// Histórico de pausas
app.get("/api/historico", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "token" });
  res.json({ total: pausa.historico.length, historico: pausa.historico });
});

// ---- LOG DE PEDIDOS DE ATENDIMENTO HUMANO ----
app.get("/api/humanos", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "token" });
  const total = humanosLog.length;
  const hoje = new Date().toDateString();
  const hojeCount = humanosLog.filter(h => new Date(h.quando).toDateString() === hoje).length;
  res.json({ total, hoje: hojeCount, lista: humanosLog });
});
app.post("/api/humanos/limpar", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "token" });
  humanosLog = [];
  salvarHumanos();
  res.json({ ok: true });
});
app.get("/api/humanos/limpar", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "token" });
  humanosLog = [];
  salvarHumanos();
  res.json({ ok: true });
});

// ---- PAINEL VISUAL ----
app.get("/painel", (_req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8").send(DASHBOARD_HTML);
});

app.get("/", (_req, res) =>
  texto(res, `API anti-duplicado OK\nNumeros: ${registro.size}\nBloqueio: ${DEDUP_DAYS > 0 ? DEDUP_DAYS + " dias" : "permanente"}\nGeracao de testes: ${pausa.ativa ? "PAUSADA (" + pausa.motivo + ")" : "ativa"}\nAviso humanos: ${AVISO_HUMANOS.join(", ")}\n\nPainel visual: /painel`)
);

app.listen(PORT, () => console.log(`[ok] porta ${PORT}`));
