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

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "telefone,data_iso\n");

const registro = new Map();
(function carregar() {
  const linhas = fs.readFileSync(DB_FILE, "utf8").split("\n");
  for (const ln of linhas) {
    const [tel, iso] = ln.split(",");
    const t = soDigitos(tel);
    if (t) registro.set(t, Date.parse(iso) || Date.now());
  }
  console.log(`[init] ${registro.size} numeros carregados.`);
})();

function soDigitos(v) { return String(v == null ? "" : v).replace(/\D/g, ""); }

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

async function gerarTesteNoPainel(rawBody, contentType) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    // repassa pro painel o MESMO pacote que o BotBot mandou (com senderPhone etc.)
    const r = await fetch(PAINEL_URL, {
      method: "POST",
      headers: { "Content-Type": contentType || "application/json" },
      body: rawBody && rawBody.length ? rawBody : "{}",
      signal: ctrl.signal,
    });
    const body = (await r.text()).slice(0, 300);
    console.log(`[painel] status=${r.status} resp=${body}`);
  } catch (e) {
    console.error("[painel] erro:", e.message);
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

const app = express();
const captureRaw = (req, _res, buf) => { req.rawBody = buf.toString(); };
app.use(express.json({ verify: captureRaw }));
app.use(express.urlencoded({ extended: true, verify: captureRaw }));

function texto(res, s) { res.set("Content-Type", "text/plain; charset=utf-8").send(s); }

function handleTeste(req, res) {
  logReq(req);
  const telefone = extrairTelefone(req);
  if (!telefone) return texto(res, MSG_SEM_NUMERO);
  if (jaBloqueado(telefone)) return texto(res, MSG_JA_TESTOU);
  gravar(telefone);
  texto(res, MSG_GERANDO);
  gerarTesteNoPainel(req.rawBody, req.headers["content-type"]).catch(() => {});
}
app.post("/teste", handleTeste);
app.get("/teste", handleTeste);

app.get("/debug", (_req, res) => {
  texto(res, "ULTIMAS CHAMADAS:\n\n" + ultimas.map(u => JSON.stringify(u, null, 2)).join("\n\n"));
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

app.get("/", (_req, res) =>
  texto(res, `API anti-duplicado OK\nNumeros: ${registro.size}\nBloqueio: ${DEDUP_DAYS > 0 ? DEDUP_DAYS + " dias" : "permanente"}`)
);

app.listen(PORT, () => console.log(`[ok] porta ${PORT}`));
