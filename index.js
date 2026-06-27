// =====================================================================
//  ANTI-TESTE-DUPLICADO — LiberouTV  (API para EasyPanel / VPS)
//  BotBot (botão "Já instalei") -> ESTA API -> painelblackbr
//
//  - Recebe o telefone do cliente.
//  - Número JÁ cadastrado  -> NÃO gera de novo (responde "já testou").
//  - Número NOVO           -> grava no arquivo + chama o painelblackbr.
//  - O arquivo /app/data/clientes.csv é a sua lista de números (com data).
// =====================================================================

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ----------------------- CONFIG (via variáveis de ambiente) -----------------------
const PORT        = process.env.PORT || 3000;
const PAINEL_URL  = process.env.PAINEL_API_URL ||
                    "https://painelblackbr.site/api/chatbot/lKWOzMODzo/qK4WrkQ1eN";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "troque-este-token";
// 0 = bloqueio permanente (1 teste por número pra sempre).
// >0 = bloqueia por X dias (ex: 30 -> pode testar de novo depois de 30 dias).
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
const MSG_ERRO =
  "Ops, deu um probleminha aqui. 🙈 Digite *HUMANO* para falar com um atendente.";

// ----------------------- ARMAZENAMENTO (arquivo + memória) -----------------------
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "telefone,data_iso\n");

/** Map<telefone, timestamp_ms_do_ultimo_teste> */
const registro = new Map();
(function carregar() {
  const linhas = fs.readFileSync(DB_FILE, "utf8").split("\n");
  for (const ln of linhas) {
    const [tel, iso] = ln.split(",");
    const t = soDigitos(tel);
    if (t) registro.set(t, Date.parse(iso) || Date.now());
  }
  console.log(`[init] ${registro.size} números carregados.`);
})();

function soDigitos(v) {
  return String(v == null ? "" : v).replace(/\D/g, "");
}

function jaBloqueado(telefone) {
  if (!registro.has(telefone)) return false;
  if (DEDUP_DAYS <= 0) return true; // permanente
  const ultimo = registro.get(telefone);
  const dias = (Date.now() - ultimo) / (1000 * 60 * 60 * 24);
  return dias < DEDUP_DAYS;
}

function gravar(telefone) {
  const agora = Date.now();
  registro.set(telefone, agora);
  fs.appendFileSync(DB_FILE, `${telefone},${new Date(agora).toISOString()}\n`);
}

// ----------------------- CHAMA O PAINEL (gera o teste) -----------------------
async function gerarTesteNoPainel(telefone) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(PAINEL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ telefone }),
      signal: ctrl.signal,
    });
    const body = (await r.text()).trim();
    // Só repassa o corpo se o painel respondeu com sucesso (2xx) E parece texto.
    // Senão (erro, vazio ou HTML), manda a msg padrão — o painel costuma
    // enviar o teste por conta própria pro WhatsApp do cliente.
    const ehTexto = r.ok && body.length > 0 && body.charAt(0) !== "<";
    return ehTexto ? body : MSG_GERANDO;
  } catch (e) {
    console.error("[painel] erro:", e.message);
    return MSG_GERANDO; // já gravamos; o painel pode ter recebido mesmo assim
  } finally {
    clearTimeout(timer);
  }
}

function extrairTelefone(req) {
  const b = req.body || {};
  const q = req.query || {};
  const cand =
    b.telefone || b.phone || b.numero || b.number || b.from || b.contato ||
    q.telefone || q.phone || q.numero || q.number || q.from || q.contato || "";
  return soDigitos(cand);
}

// ----------------------- SERVIDOR -----------------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => {
  console.log(`[req] ${req.method} ${req.path}`, JSON.stringify(req.body || {}));
  next();
});

function responder(res, texto) {
  res.set("Content-Type", "text/plain; charset=utf-8").send(texto);
}

// Endpoint principal — é AQUI que o botão do BotBot vai apontar.
app.post("/teste", async (req, res) => {
  try {
    const telefone = extrairTelefone(req);
    if (!telefone) return responder(res, MSG_SEM_NUMERO);

    if (jaBloqueado(telefone)) return responder(res, MSG_JA_TESTOU);

    gravar(telefone); // grava antes de chamar (evita corrida/clique duplo)
    const resposta = await gerarTesteNoPainel(telefone);
    return responder(res, resposta);
  } catch (e) {
    console.error("[/teste] erro:", e);
    return responder(res, MSG_ERRO);
  }
});

// Ver os números cadastrados:  GET /numeros?token=SEU_TOKEN
app.get("/numeros", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).send("Token inválido.");
  const lista = [...registro.entries()].map(
    ([tel, ts]) => `${tel} — ${new Date(ts).toLocaleString("pt-BR")}`
  );
  responder(res, `Total: ${lista.length}\n\n${lista.join("\n")}`);
});

// Apagar um número (libera novo teste):  GET /apagar?token=...&telefone=...
app.get("/apagar", (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).send("Token inválido.");
  const tel = soDigitos(req.query.telefone);
  if (!tel || !registro.has(tel)) return responder(res, "Número não encontrado.");
  registro.delete(tel);
  // reescreve o arquivo sem esse número
  const linhas = ["telefone,data_iso"];
  for (const [t, ts] of registro.entries()) linhas.push(`${t},${new Date(ts).toISOString()}`);
  fs.writeFileSync(DB_FILE, linhas.join("\n") + "\n");
  responder(res, `Número ${tel} liberado para novo teste. ✅`);
});

// Saúde / teste rápido no navegador
app.get("/", (_req, res) =>
  responder(res, `API anti-duplicado OK ✅\nNúmeros cadastrados: ${registro.size}\nBloqueio: ${DEDUP_DAYS > 0 ? DEDUP_DAYS + " dias" : "permanente"}`)
);

app.listen(PORT, () => console.log(`[ok] rodando na porta ${PORT}`));
