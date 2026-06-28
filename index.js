// =====================================================================
//  ANTI-TESTE-DUPLICADO — LiberouTV  (v3 — resposta instantânea + /debug)
//  BotBot (botão "Já instalei") -> ESTA API -> painelblackbr
//
//  Estratégia: responde IMEDIATAMENTE pro BotBot (não trava) e chama o
//  painel por trás. Bloqueia número repetido. Guarda a lista de números.
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
const DB_FILE     = path.join(DATA_DIR, "clientes.csv");

const MSG_JA_TESTOU =
  "⚠️ Esse número já usou o teste grátis. 😊\n\n" +
  "Mas posso te ajudar a assinar agora! Digite *PLANOS* para ver os valores " +
  "ou *HUMANO* para falar com a equipe.";
const MSG_GERANDO =
  "🎉 *Instalação confirmada!*\n\n⏳ Gerando seu TESTE GRÁTIS, aguarde alguns segundos...";
const MSG_SEM_NUMERO =
  "Não consegui identificar seu número. 😕 Digite *HUMANO* que um atendente te ajuda.";

// Link de venda usado quando o painel não mandar um payUrl do cliente
const LINK_VENDA_PADRAO = process.env.LINK_VENDA ||
  "https://painelblackbr.site/#/checkout/241KARvDmx/VrW8PmVPWK";

// ---- mensagem quando o número JÁ testou (negado) -> leva pra venda ----
function msgJaTestou(payUrl) {
  const link = payUrl || LINK_VENDA_PADRAO;
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
"▪ VIZZION PLAY (Samsung, LG, Roku, Android)\n" +
"  Código: 701266\n" +
`  User: ${u} | Senha: ${p}\n` +
"▪ ASSIST+ (Samsung, LG, Roku, Android)\n" +
"  Código: 926692\n" +
`  User: ${u} | Senha: ${p}\n` +
"▪ EPICPLAY (Samsung, LG, Roku, Android)\n" +
"  Código: 456642\n" +
`  User: ${u} | Senha: ${p}\n` +
"▪ MAGIC PLAYER (Roku, LG, Android)\n" +
"  Código: 926692\n" +
`  User: ${u} | Senha: ${p}\n` +
"▪ ZINK (Playstore, Fire TV, Roku)\n" +
`  User: ${u} | Senha: ${p}\n` +
"▪ PLAYER OTT (Playstore, Roku)\n" +
`  User: ${u} | Senha: ${p}\n` +
"▪ UNI TV (Android)\n" +
"  Downloader: 9387398\n" +
"LIBEROU TV ®️"
  );
}

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "telefone,data_iso\n");

const registro = new Map();
function soDigitos(v) { return String(v == null ? "" : v).replace(/\D/g, ""); }

(function carregar() {
  const linhas = fs.readFileSync(DB_FILE, "utf8").split("\n");
  for (const ln of linhas) {
    const [tel, iso] = ln.split(",");
    const t = soDigitos(tel);
    if (t) registro.set(t, Date.parse(iso) || Date.now());
  }
  console.log(`[init] ${registro.size} numeros carregados.`);
})();

function jaBloqueado(telefone) {
  if (!registro.has(telefone)) return false;
  if (DEDUP_DAYS <= 0) return true;
  const dias = (Date.now() - registro.get(telefone)) / (1000 * 60 * 60 * 24);
  return dias < DEDUP_DAYS;
}
function gravar(telefone) {
  const agora = Date.now();
  registro.set(telefone, agora);
  fs.appendFileSync(DB_FILE, `${telefone},${new Date(agora).toISOString()}\n`);
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
.wrap{max-width:980px;margin:0 auto;padding:20px}
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
.toolbar{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.toolbar input{flex:1;min-width:160px;padding:10px 12px;border-radius:10px;border:1px solid #2c3142;background:#0f1117;color:#fff}
.mini{padding:9px 12px;font-size:13px}
.gray{background:#2c3142;color:#e7e9ee}.gray:hover{background:#363c50}
.red{background:#ef4444;color:#fff}.red:hover{background:#d83a3a}
.green{background:#22c55e;color:#04210f}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:11px 10px;border-bottom:1px solid #242938;font-size:14px}
th{color:#8b90a0;font-weight:600;font-size:12px;text-transform:uppercase}
td.num{font-variant-numeric:tabular-nums;font-weight:600}
.act{display:flex;gap:6px}
.act a,.act button{font-size:12px;padding:6px 10px;border-radius:8px;text-decoration:none}
.wa{background:#0b3b2e;color:#34d399;display:inline-flex;align-items:center}
.empty{text-align:center;color:#8b90a0;padding:30px}
.err{color:#f87171;font-size:13px;margin-top:6px;min-height:16px}
.foot{color:#5b6072;font-size:12px;text-align:center;margin-top:20px}
@media(max-width:560px){.stats{grid-template-columns:1fr 1fr}.hide-sm{display:none}}
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
    <div class="sub">Números que já geraram teste grátis</div>
    <div class="stats">
      <div class="stat"><div class="n" id="s-total">0</div><div class="l">Total cadastrados</div></div>
      <div class="stat"><div class="n" id="s-hoje">0</div><div class="l">Testaram hoje</div></div>
      <div class="stat"><div class="n" id="s-bloq">—</div><div class="l">Bloqueio</div></div>
    </div>
    <div class="card">
      <div class="toolbar">
        <input id="busca" placeholder="🔎 Buscar número..." oninput="render()" />
        <button class="mini gray" onclick="carregar()">↻ Atualizar</button>
        <button class="mini gray" onclick="baixarCSV()">⬇ CSV</button>
        <button class="mini red" onclick="limparTudo()">Liberar todos</button>
      </div>
      <div id="tabela"></div>
    </div>
    <div class="foot">Liberou TV · sair fechando a aba</div>
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
  }).catch(function(){document.getElementById("loginerr").textContent="Erro de conexão."});
}
function carregar(){
  fetch("/api/numeros?token="+q(TK)).then(function(r){return r.json()}).then(aplicar);
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
function render(){
  var f=(document.getElementById("busca").value||"").replace(/\\D/g,"");
  var lista=DADOS.filter(function(x){return !f||x.telefone.indexOf(f)>=0});
  if(!lista.length){document.getElementById("tabela").innerHTML='<div class="empty">Nenhum número encontrado.</div>';return}
  var h='<table><thead><tr><th>#</th><th>Número</th><th class="hide-sm">Data</th><th>Ações</th></tr></thead><tbody>';
  lista.forEach(function(x,i){
    h+='<tr><td>'+(i+1)+'</td><td class="num">'+x.telefone+'</td><td class="hide-sm">'+fmt(x.data)+'</td>'+
       '<td><div class="act">'+
       '<a class="wa" target="_blank" href="https://wa.me/'+x.telefone+'">WhatsApp</a>'+
       '<button class="red" onclick="apagar(\\''+x.telefone+'\\')">Apagar</button>'+
       '</div></td></tr>';
  });
  h+='</tbody></table>';
  document.getElementById("tabela").innerHTML=h;
}
function apagar(tel){
  if(!confirm("Liberar o número "+tel+" para gerar teste de novo?"))return;
  fetch("/apagar?token="+q(TK)+"&telefone="+q(tel)).then(function(){carregar()});
}
function limparTudo(){
  if(!confirm("ATENÇÃO: isso libera TODOS os números (todos poderão testar de novo). Continuar?"))return;
  fetch("/api/limpar?token="+q(TK)).then(function(){carregar()});
}
function baixarCSV(){
  var linhas=["telefone,data"];
  DADOS.forEach(function(x){linhas.push(x.telefone+","+fmt(x.data))});
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
  if (!telefone) return responderBotBot(res, MSG_SEM_NUMERO);

  // JÁ TESTOU -> mensagem de venda (não chama o painel)
  if (jaBloqueado(telefone)) return responderBotBot(res, msgJaTestou());

  // número novo -> chama o painel e monta a mensagem personalizada
  const r = await gerarTesteNoPainel(req.rawBody, req.headers["content-type"]);
  let d = null;
  try { d = JSON.parse(r.body); } catch (e) {}

  if (d && d.username && d.password) {
    gravar(telefone);                       // só bloqueia se REALMENTE gerou o teste
    return responderBotBot(res, msgTesteAprovado(d));
  }

  // painel não retornou um teste válido -> NÃO bloqueia (deixa tentar de novo)
  return responderBotBot(res, MSG_GERANDO);
}
app.post("/teste", handleTeste);
app.get("/teste", handleTeste);

app.get("/debug", (_req, res) => {
  texto(res,
    "== ULTIMAS CHAMADAS DO BOTBOT ==\n\n" +
    ultimas.map(u => JSON.stringify(u, null, 2)).join("\n\n") +
    "\n\n\n== ULTIMAS RESPOSTAS DO PAINEL ==\n\n" +
    painelLog.map(u => JSON.stringify(u, null, 2)).join("\n\n"));
});

app.get("/numeros", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).send("Token invalido.");
  const lista = [...registro.entries()].map(([t, ts]) => `${t} - ${new Date(ts).toLocaleString("pt-BR")}`);
  texto(res, `Total: ${lista.length}\n\n${lista.join("\n")}`);
});

app.get("/apagar", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).send("Token invalido.");
  const tel = soDigitos(req.query.telefone);
  if (!tel || !registro.has(tel)) return texto(res, "Numero nao encontrado.");
  registro.delete(tel);
  const linhas = ["telefone,data_iso"];
  for (const [t, ts] of registro.entries()) linhas.push(`${t},${new Date(ts).toISOString()}`);
  fs.writeFileSync(DB_FILE, linhas.join("\n") + "\n");
  texto(res, `Numero ${tel} liberado. OK`);
});

// ---- endpoints JSON para o painel visual ----
app.get("/api/numeros", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "token" });
  const lista = [...registro.entries()]
    .map(([telefone, data]) => ({ telefone, data }))
    .sort((a, b) => b.data - a.data);
  res.json({ total: lista.length, dedupDays: DEDUP_DAYS, lista });
});

app.get("/api/limpar", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "token" });
  registro.clear();
  fs.writeFileSync(DB_FILE, "telefone,data_iso\n");
  res.json({ ok: true });
});

// ---- PAINEL VISUAL ----
app.get("/painel", (_req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8").send(DASHBOARD_HTML);
});

app.get("/", (_req, res) =>
  texto(res, `API anti-duplicado OK\nNumeros: ${registro.size}\nBloqueio: ${DEDUP_DAYS > 0 ? DEDUP_DAYS + " dias" : "permanente"}\n\nPainel visual: /painel`)
);

app.listen(PORT, () => console.log(`[ok] porta ${PORT}`));
