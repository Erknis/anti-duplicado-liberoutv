# API Anti-Teste-Duplicado — Deploy no EasyPanel

Esta API fica **entre o BotBot e o painelblackbr**. Ela guarda os números dos
clientes e só deixa gerar teste **1x por número**. O arquivo `data/clientes.csv`
vira a sua lista de números (com data).

---

## Passo 1 — Subir o código

Você tem 2 caminhos no EasyPanel:

**A) Pelo GitHub (recomendado):**
1. Crie um repositório no GitHub (pode ser privado) e suba estes arquivos
   (`index.js`, `package.json`, `Dockerfile`, `.dockerignore`).
2. No EasyPanel: **Create → App** → em *Source* escolha **GitHub** e selecione o repo.
3. Em *Build*, escolha **Dockerfile** (o EasyPanel detecta sozinho).

**B) Sem GitHub (Dockerfile direto):**
- Crie o App e em *Source* use **Git** apontando para um repositório,
  ou suba os arquivos para o servidor e use a opção de build por Dockerfile.

---

## Passo 2 — Volume (pra não perder os números)

No App, vá em **Mounts / Volumes** e crie um volume:
- **Mount Path:** `/app/data`

Isso mantém o `clientes.csv` salvo mesmo quando você atualizar o app.

---

## Passo 3 — Variáveis de ambiente (Environment)

| Variável         | Valor                                                                 |
|------------------|-----------------------------------------------------------------------|
| `ADMIN_TOKEN`    | uma senha sua (ex: `liberou2026xyz`) — protege a lista de números      |
| `DEDUP_DAYS`     | `0` = bloqueio permanente • `30` = libera de novo após 30 dias         |
| `PAINEL_API_URL` | (opcional) já vem com a URL do seu painel; só mude se trocar de painel |

A porta já é a **3000** (definida no Dockerfile). No EasyPanel, configure o
*Proxy/Port* do app para **3000** se ele pedir.

---

## Passo 4 — Domínio + Deploy

1. Em **Domains**, adicione um domínio/subdomínio (ex: `bot.seudominio.com`)
   ou use o domínio que o EasyPanel oferece. Ative **HTTPS**.
2. Clique em **Deploy**.

---

## Passo 5 — Testar

- Abra no navegador: `https://SEU-DOMINIO/`
  → deve aparecer: `API anti-duplicado OK ✅`
- Ver os números:   `https://SEU-DOMINIO/numeros?token=SEU_ADMIN_TOKEN`
- Liberar um número: `https://SEU-DOMINIO/apagar?token=SEU_ADMIN_TOKEN&telefone=5599...`

---

## Passo 6 — Me mandar a URL

Me envie a URL final do endpoint, que é:

```
https://SEU-DOMINIO/teste
```

Que eu troco em **todos os botões de teste** do fluxo (8 aparelhos + tutoriais)
pra apontarem pra ela, configurando o envio do `telefone`. Aí te devolvo o ZIP final.

---

### Endpoints
- `POST /teste`   → recebe `{ "telefone": "..." }`, bloqueia duplicado, chama o painel.
- `GET  /`        → status.
- `GET  /numeros?token=...`  → lista os números.
- `GET  /apagar?token=...&telefone=...` → libera um número específico.
